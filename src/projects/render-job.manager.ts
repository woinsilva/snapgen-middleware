import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { processIdentity } from '../runtime/process-identity.js';
import type { Logger } from '../utils/logger.js';
import type { StatelessProjectService } from './project.service.js';

export type RenderJobStatus = 'processing' | 'completed' | 'failed';
export type RenderJobCleanupReason = 'terminal_ttl_expired' | 'output_expired' | 'shutdown' | 'manual_internal_cleanup';

export interface RenderJobResponse {
  projectId: string;
  renderJobId: string;
  status: RenderJobStatus;
  projectState: string | null;
  downloadUrl: string | null;
  outputExpiresAt: string | null;
  error: { code: string; message: string } | null;
}

interface RenderJob extends RenderJobResponse {
  abortController: AbortController;
  executionTimer?: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
  createdAtMs: number;
  cleanupReason?: RenderJobCleanupReason;
}

const silentLogger: Logger = { info: () => undefined, error: () => undefined };

export class RenderJobManager {
  private readonly jobs = new Map<string, RenderJob>();
  private readonly projectJobs = new Map<string, string>();
  private accepting = true;

  constructor(
    private readonly projects: StatelessProjectService,
    private readonly publicBaseUrl: string,
    private readonly terminalTtlSeconds = 3_600,
    private readonly maxExecutionSeconds = 43_200,
    private readonly logger: Logger = silentLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(projectState: string, requestId: string): RenderJobResponse {
    if (!this.accepting) throw new ApiError(503, 'SERVICE_SHUTTING_DOWN', 'New render jobs are not accepted during shutdown.');
    const state = this.projects.assertReadyToRender(projectState);
    const existingId = this.projectJobs.get(state.projectId);
    if (existingId) {
      const existing = this.jobs.get(this.key(state.projectId, existingId));
      if (existing) return this.response(existing);
      this.projectJobs.delete(state.projectId);
    }

    const renderJobId = randomUUID();
    const job: RenderJob = {
      projectId: state.projectId,
      renderJobId,
      status: 'processing',
      projectState: null,
      downloadUrl: null,
      outputExpiresAt: null,
      error: null,
      abortController: new AbortController(),
      createdAtMs: this.now().getTime(),
    };
    this.jobs.set(this.key(state.projectId, renderJobId), job);
    this.projectJobs.set(state.projectId, renderJobId);
    job.executionTimer = setTimeout(() => this.timeout(job), this.maxExecutionSeconds * 1_000);
    job.executionTimer.unref();
    this.log('render_job_created', job, { activeJobCount: this.activeJobCount(), maxExecutionSeconds: this.maxExecutionSeconds });
    setImmediate(() => { void this.run(job, projectState, requestId); });
    return this.response(job);
  }

  get(projectId: string, renderJobId: string): RenderJobResponse {
    const job = this.jobs.get(this.key(projectId, renderJobId));
    if (!job) throw new ApiError(404, 'RENDER_JOB_NOT_FOUND', 'Render job was not found or has expired.');
    this.markExpiredOutput(job);
    return this.response(job);
  }

  activeJobCount(): number { return [...this.jobs.values()].filter((job) => job.status === 'processing').length; }

  beginShutdown(): { active: number; total: number } {
    this.accepting = false;
    const active = this.activeJobCount();
    for (const job of this.jobs.values()) {
      if (job.status !== 'processing') continue;
      job.cleanupReason = 'shutdown';
      this.log('render_job_interrupted', job, { cleanupReason: 'shutdown', activeJobCount: active });
      this.fail(job, 'RENDER_INTERRUPTED', 'Render was interrupted by process shutdown.', true);
    }
    return { active, total: this.jobs.size };
  }

  private async run(job: RenderJob, projectState: string, requestId: string): Promise<void> {
    this.log('render_job_started', job, { activeJobCount: this.activeJobCount() });
    try {
      const result = await this.projects.render(projectState, requestId, { signal: job.abortController.signal, renderJobId: job.renderJobId });
      if (job.status !== 'processing') {
        this.log('render_job_late_completion_ignored', job, { elapsedMs: this.elapsed(job) });
        return;
      }
      if (!result.downloadUrl || !result.outputExpiresAt) throw new Error('Renderer completed without output metadata');
      this.clearExecutionTimer(job);
      job.status = 'completed';
      job.projectState = result.projectState;
      job.downloadUrl = new URL(result.downloadUrl, this.publicBaseUrl).toString();
      job.outputExpiresAt = result.outputExpiresAt;
      this.log('render_job_completed', job, { elapsedMs: this.elapsed(job), activeJobCount: this.activeJobCount() });
      this.startTerminalRetention(job);
    } catch (error) {
      if (job.status !== 'processing') {
        this.log('render_job_late_failure_ignored', job, { elapsedMs: this.elapsed(job) });
        return;
      }
      const code = error instanceof ApiError ? error.code : 'PROJECT_RENDER_FAILED';
      const message = error instanceof ApiError ? error.message : 'Project rendering failed.';
      this.fail(job, code, message, false);
    }
  }

  private timeout(job: RenderJob): void {
    if (job.status !== 'processing') return;
    this.log('render_job_execution_timeout', job, { elapsedMs: this.elapsed(job), errorCode: 'RENDER_EXECUTION_TIMEOUT' });
    this.fail(job, 'RENDER_EXECUTION_TIMEOUT', 'Render exceeded its maximum execution time.', true);
  }

  private fail(job: RenderJob, code: string, message: string, abort: boolean): void {
    if (job.status !== 'processing') return;
    this.clearExecutionTimer(job);
    if (abort) job.abortController.abort();
    job.status = 'failed';
    job.error = { code, message };
    this.log('render_job_failed', job, { elapsedMs: this.elapsed(job), errorCode: code, activeJobCount: this.activeJobCount() });
    this.startTerminalRetention(job);
  }

  private markExpiredOutput(job: RenderJob): void {
    if (job.status !== 'completed' || !job.outputExpiresAt || new Date(job.outputExpiresAt).getTime() > this.now().getTime()) return;
    job.status = 'failed';
    job.downloadUrl = null;
    job.cleanupReason = 'output_expired';
    job.error = { code: 'OUTPUT_EXPIRED', message: 'The rendered output has expired.' };
    this.log('render_job_output_expired', job, { cleanupReason: 'output_expired', elapsedMs: this.elapsed(job), errorCode: 'OUTPUT_EXPIRED' });
  }

  private startTerminalRetention(job: RenderJob): void {
    if (job.status === 'processing' || job.cleanupTimer) return;
    job.cleanupTimer = setTimeout(() => this.remove(job.projectId, job.renderJobId, 'terminal_ttl_expired'), this.terminalTtlSeconds * 1_000);
    job.cleanupTimer.unref();
  }

  private remove(projectId: string, renderJobId: string, reason: RenderJobCleanupReason): void {
    const key = this.key(projectId, renderJobId);
    const job = this.jobs.get(key);
    if (!job) return;
    if (job.status === 'processing') {
      this.log('render_job_cleanup_skipped', job, { cleanupReason: reason, activeJobCount: this.activeJobCount() });
      return;
    }
    this.clearExecutionTimer(job);
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    job.cleanupReason = reason;
    this.jobs.delete(key);
    if (this.projectJobs.get(projectId) === renderJobId) this.projectJobs.delete(projectId);
    this.log('render_job_cleaned', job, { cleanupReason: reason, activeJobCount: this.activeJobCount() });
  }

  private clearExecutionTimer(job: RenderJob): void {
    if (!job.executionTimer) return;
    clearTimeout(job.executionTimer);
    job.executionTimer = undefined;
  }

  private elapsed(job: RenderJob): number { return Math.max(0, this.now().getTime() - job.createdAtMs); }

  private log(event: string, job: RenderJob, details: Record<string, unknown>): void {
    this.logger.info({ event, ...processIdentity, projectId: job.projectId, renderJobId: job.renderJobId, status: job.status, ...details });
  }

  private response(job: RenderJob): RenderJobResponse {
    return {
      projectId: job.projectId,
      renderJobId: job.renderJobId,
      status: job.status,
      projectState: job.projectState,
      downloadUrl: job.downloadUrl,
      outputExpiresAt: job.outputExpiresAt,
      error: job.error,
    };
  }

  private key(projectId: string, renderJobId: string): string { return `${projectId}:${renderJobId}`; }
}
