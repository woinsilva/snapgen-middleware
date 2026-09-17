import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { processIdentity } from '../runtime/process-identity.js';
import type { Logger } from '../utils/logger.js';
import type { ValidatedProjectState } from './project.schemas.js';
import type { ProjectResponse, StatelessProjectService } from './project.service.js';

export type GenerationJobStatus = 'processing' | 'assembling' | 'failed';

export interface GenerationJobResponse {
  projectId: string;
  generationJobId: string;
  status: GenerationJobStatus;
  projectState: string;
  scenes: { total: number; completed: number; processing: number; pending: number };
  progress: number;
  maxPaidOperations: number;
  error: { code: string; message: string } | null;
}

interface GenerationJob extends GenerationJobResponse {
  planFingerprint: string;
  authorizedScenes: ReadonlySet<number>;
  currentSceneSequence: number | null;
  providerUuid: string | null;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
}

export interface GenerationJobManagerOptions {
  jobTtlSeconds?: number;
  pollInitialMs?: number;
  pollMaximumMs?: number;
  maxPollsPerScene?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  logger?: Logger;
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const silentLogger: Logger = { info: () => undefined, error: () => undefined };

function fingerprint(state: ValidatedProjectState): string {
  const plan = {
    projectId: state.projectId,
    model: state.model,
    generationStrategy: state.generationStrategy,
    targetDuration: state.targetDuration,
    segmentDuration: state.segmentDuration,
    plannedSegmentCount: state.plannedSegmentCount,
    rawDuration: state.rawDuration,
    trimDuration: state.trimDuration,
    resolution: state.resolution,
    aspectRatio: state.aspectRatio,
    concept: state.concept,
    visualBible: state.visualBible,
    scenes: state.scenes.map(({ sequence, prompt, continuityInstructions, operation }) => ({ sequence, prompt, continuityInstructions, operation })),
  };
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export class GenerationJobManager {
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly projectJobs = new Map<string, string>();
  private readonly jobTtlSeconds: number;
  private readonly pollInitialMs: number;
  private readonly pollMaximumMs: number;
  private readonly maxPollsPerScene: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: Logger;
  private accepting = true;

  constructor(private readonly projects: StatelessProjectService, options: GenerationJobManagerOptions = {}) {
    this.jobTtlSeconds = options.jobTtlSeconds ?? 14_400;
    this.pollInitialMs = options.pollInitialMs ?? 5_000;
    this.pollMaximumMs = options.pollMaximumMs ?? 30_000;
    this.maxPollsPerScene = options.maxPollsPerScene ?? 120;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  start(projectState: string, requestId: string): GenerationJobResponse {
    if (!this.accepting) throw new ApiError(503, 'SERVICE_SHUTTING_DOWN', 'New generation jobs are not accepted during shutdown.');
    const initial = this.projects.verify(projectState);
    const existing = this.activeFor(initial.projectId);
    if (existing) {
      if (existing.planFingerprint !== fingerprint(initial)) {
        throw new ApiError(409, 'GENERATION_JOB_PLAN_MISMATCH', 'An active generation job is bound to a different signed project plan.');
      }
      return this.response(existing);
    }
    this.assertStartable(initial);
    const authorizedScenes = new Set(initial.scenes.filter((scene) => scene.status === 'pending').map((scene) => scene.sequence));
    const remainingBudget = initial.maxPaidOperations - initial.paidOperations;
    if (authorizedScenes.size > remainingBudget) {
      throw new ApiError(409, 'PAID_OPERATION_BUDGET_EXHAUSTED', 'The remaining project budget cannot cover all pending scenes.');
    }

    const reserved = this.projects.reserveNextScene(projectState);
    const reservedScene = this.projects.verify(reserved.projectState).scenes.find((scene) => scene.status === 'submitting');
    const generationJobId = randomUUID();
    const expiryTimer = setTimeout(() => this.expire(initial.projectId, generationJobId), this.jobTtlSeconds * 1_000);
    expiryTimer.unref();
    const job: GenerationJob = {
      projectId: initial.projectId,
      generationJobId,
      status: 'processing',
      projectState: reserved.projectState,
      scenes: reserved.scenes,
      progress: reserved.progress,
      maxPaidOperations: authorizedScenes.size,
      error: null,
      planFingerprint: fingerprint(initial),
      authorizedScenes,
      currentSceneSequence: reservedScene?.sequence ?? null,
      providerUuid: null,
      expiresAt: this.now() + this.jobTtlSeconds * 1_000,
      expiryTimer,
    };
    this.jobs.set(this.key(job.projectId, job.generationJobId), job);
    this.projectJobs.set(job.projectId, job.generationJobId);
    this.log('generation_job_created', job, { activeJobCount: this.activeJobCount(), maxPaidOperations: job.maxPaidOperations });
    this.log('generation_scene_reserved', job, { sceneSequence: job.currentSceneSequence });
    setImmediate(() => { void this.run(job, requestId); });
    return this.response(job);
  }

  get(projectId: string, generationJobId: string): GenerationJobResponse {
    const job = this.jobs.get(this.key(projectId, generationJobId));
    if (!job) throw new ApiError(404, 'GENERATION_JOB_NOT_FOUND', 'Generation job was not found, was lost after restart, or has expired.');
    return this.response(job);
  }

  assertManualAdvanceAllowed(projectState: string): void {
    const state = this.projects.verify(projectState);
    if (this.activeFor(state.projectId)) {
      throw new ApiError(409, 'GENERATION_JOB_ACTIVE', 'Manual project advance is disabled while a whole-project generation job exists.');
    }
  }

  activeJobCount(): number { return [...this.jobs.values()].filter((job) => job.status === 'processing').length; }

  beginShutdown(): { active: number; total: number } {
    this.accepting = false;
    const active = this.activeJobCount();
    for (const job of this.jobs.values()) {
      if (job.status !== 'processing') continue;
      this.log('generation_job_interrupted', job, { activeJobCount: active, errorCode: 'GENERATION_JOB_INTERRUPTED' });
      this.fail(job, 'GENERATION_JOB_INTERRUPTED', 'Generation job was interrupted by process shutdown.');
    }
    return { active, total: this.jobs.size };
  }

  private async run(job: GenerationJob, requestId: string): Promise<void> {
    try {
      while (job.status === 'processing') {
        if (this.isExpired(job)) return;
        const reserved = this.projects.verify(job.projectState).scenes.find((scene) => scene.status === 'submitting');
        if (!reserved || !job.authorizedScenes.has(reserved.sequence)) {
          return this.fail(job, 'GENERATION_JOB_STATE_INVALID', 'The reserved scene is outside the authorized generation plan.');
        }
        const submitted = await this.projects.submitReservedScene(job.projectState, `${requestId}:scene-${reserved.sequence}:submit`);
        this.update(job, submitted);
        if (submitted.status === 'failed') return this.failFromProject(job, submitted);
        this.log('generation_provider_submitted', job, { sceneSequence: reserved.sequence, providerUuid: job.providerUuid });
        this.log('generation_scene_processing', job, { sceneSequence: reserved.sequence, providerUuid: job.providerUuid });
        if (this.isExpired(job)) return;

        let delay = this.pollInitialMs;
        let polls = 0;
        while (this.projects.verify(job.projectState).scenes.some((scene) => scene.status === 'processing')) {
          if (polls >= this.maxPollsPerScene) {
            return this.fail(job, 'GENERATION_JOB_POLL_LIMIT', 'Provider status polling limit was reached; generation was not resubmitted.');
          }
          await this.sleep(delay);
          if (this.isExpired(job)) return;
          const status = await this.projects.status(job.projectState, `${requestId}:scene-${reserved.sequence}:poll-${polls + 1}`);
          this.update(job, status);
          polls += 1;
          delay = Math.min(this.pollMaximumMs, Math.max(delay + 1, delay * 2));
          if (status.status === 'failed') return this.failFromProject(job, status);
        }

        const state = this.projects.verify(job.projectState);
        if (state.status === 'assembling') {
          job.status = 'assembling';
          this.log('generation_job_completed', job, { elapsedMs: this.elapsed(job), activeJobCount: this.activeJobCount() });
          return;
        }
        const next = state.scenes.find((scene) => scene.status === 'pending');
        if (!next || !job.authorizedScenes.has(next.sequence)) {
          return this.fail(job, 'GENERATION_JOB_STATE_INVALID', 'The next scene is outside the authorized generation plan.');
        }
        this.update(job, this.projects.reserveNextScene(job.projectState));
        this.log('generation_scene_reserved', job, { sceneSequence: job.currentSceneSequence });
      }
    } catch {
      if (job.status !== 'failed') {
        this.fail(job, 'GENERATION_JOB_FAILED', 'Generation job failed safely; manual intervention is required.');
      }
    }
  }

  private assertStartable(state: ValidatedProjectState): void {
    if (!['planning', 'generating'].includes(state.status)) {
      throw new ApiError(409, 'PROJECT_NOT_READY_FOR_GENERATION', 'Project is not ready to start a generation job.');
    }
    if (state.scenes.some((scene) => ['submitting', 'processing', 'ambiguous', 'failed'].includes(scene.status))) {
      throw new ApiError(409, 'PROJECT_NOT_IDLE', 'A generation job requires completed or pending scenes only.');
    }
    if (!state.scenes.some((scene) => scene.status === 'pending')) {
      throw new ApiError(409, 'PROJECT_HAS_NO_PENDING_SCENES', 'Project has no pending scenes to generate.');
    }
  }

  private activeFor(projectId: string): GenerationJob | undefined {
    const id = this.projectJobs.get(projectId);
    return id ? this.jobs.get(this.key(projectId, id)) : undefined;
  }

  private update(job: GenerationJob, result: ProjectResponse): void {
    job.projectState = result.projectState;
    job.scenes = result.scenes;
    job.progress = result.progress;
    const state = this.projects.verify(result.projectState);
    const active = state.scenes.find((scene) => ['submitting', 'processing'].includes(scene.status));
    job.currentSceneSequence = active?.sequence ?? null;
    job.providerUuid = active?.snapgenUuid ?? null;
  }

  private failFromProject(job: GenerationJob, result: ProjectResponse): void {
    this.fail(job, result.error?.code ?? 'GENERATION_JOB_FAILED', result.error?.message ?? 'Generation job failed.');
  }

  private fail(job: GenerationJob, code: string, message: string): void {
    if (job.status === 'failed') return;
    job.status = 'failed';
    job.error = { code, message };
    this.log(code === 'GENERATION_JOB_EXPIRED' ? 'generation_job_expired' : 'generation_job_failed', job, { elapsedMs: this.elapsed(job), errorCode: code, activeJobCount: this.activeJobCount() });
  }

  private isExpired(job: GenerationJob): boolean {
    if (job.status === 'failed') return true;
    if (this.now() < job.expiresAt) return false;
    this.fail(job, 'GENERATION_JOB_EXPIRED', 'Generation job expired and was stopped without resubmitting any scene.');
    return true;
  }

  private expire(projectId: string, generationJobId: string): void {
    const job = this.jobs.get(this.key(projectId, generationJobId));
    if (!job) return;
    if (job.status === 'processing') {
      this.fail(job, 'GENERATION_JOB_EXPIRED', 'Generation job expired and was stopped without resubmitting any scene.');
      const cleanup = setTimeout(() => this.remove(projectId, generationJobId), 300_000);
      cleanup.unref();
      return;
    }
    this.remove(projectId, generationJobId);
  }

  private response(job: GenerationJob): GenerationJobResponse {
    return {
      projectId: job.projectId,
      generationJobId: job.generationJobId,
      status: job.status,
      projectState: job.projectState,
      scenes: { ...job.scenes },
      progress: job.progress,
      maxPaidOperations: job.maxPaidOperations,
      error: job.error ? { ...job.error } : null,
    };
  }

  private remove(projectId: string, generationJobId: string): void {
    const key = this.key(projectId, generationJobId);
    const job = this.jobs.get(key);
    if (!job) return;
    clearTimeout(job.expiryTimer);
    this.jobs.delete(key);
    if (this.projectJobs.get(projectId) === generationJobId) this.projectJobs.delete(projectId);
    this.log('generation_job_cleaned', job, { cleanupReason: 'terminal_ttl_expired', activeJobCount: this.activeJobCount() });
  }

  private elapsed(job: GenerationJob): number { return Math.max(0, this.now() - (job.expiresAt - this.jobTtlSeconds * 1_000)); }

  private log(event: string, job: GenerationJob, details: Record<string, unknown>): void {
    this.logger.info({ event, ...processIdentity, projectId: job.projectId, generationJobId: job.generationJobId, status: job.status, ...details });
  }

  private key(projectId: string, generationJobId: string): string { return `${projectId}:${generationJobId}`; }
}
