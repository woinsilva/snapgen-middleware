import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import type { StatelessProjectService } from './project.service.js';

export type RenderJobStatus = 'processing' | 'completed' | 'failed';

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
  cleanupTimer: NodeJS.Timeout;
}

export class RenderJobManager {
  private readonly jobs = new Map<string, RenderJob>();
  private readonly projectJobs = new Map<string, string>();

  constructor(
    private readonly projects: StatelessProjectService,
    private readonly publicBaseUrl: string,
    private readonly jobTtlSeconds = 3_600,
  ) {}

  start(projectState: string, requestId: string): RenderJobResponse {
    const state = this.projects.assertReadyToRender(projectState);
    const existingId = this.projectJobs.get(state.projectId);
    if (existingId) {
      const existing = this.jobs.get(this.key(state.projectId, existingId));
      if (existing) return this.response(existing);
      this.projectJobs.delete(state.projectId);
    }

    const renderJobId = randomUUID();
    const cleanupTimer = setTimeout(() => this.remove(state.projectId, renderJobId), this.jobTtlSeconds * 1_000);
    cleanupTimer.unref();
    const job: RenderJob = {
      projectId: state.projectId,
      renderJobId,
      status: 'processing',
      projectState: null,
      downloadUrl: null,
      outputExpiresAt: null,
      error: null,
      cleanupTimer,
    };
    this.jobs.set(this.key(state.projectId, renderJobId), job);
    this.projectJobs.set(state.projectId, renderJobId);
    setImmediate(() => { void this.run(job, projectState, requestId); });
    return this.response(job);
  }

  get(projectId: string, renderJobId: string): RenderJobResponse {
    const job = this.jobs.get(this.key(projectId, renderJobId));
    if (!job) throw new ApiError(404, 'RENDER_JOB_NOT_FOUND', 'Render job was not found or has expired.');
    return this.response(job);
  }

  private async run(job: RenderJob, projectState: string, requestId: string): Promise<void> {
    try {
      const result = await this.projects.render(projectState, requestId);
      if (!result.downloadUrl || !result.outputExpiresAt) throw new Error('Renderer completed without output metadata');
      job.status = 'completed';
      job.projectState = result.projectState;
      job.downloadUrl = new URL(result.downloadUrl, this.publicBaseUrl).toString();
      job.outputExpiresAt = result.outputExpiresAt;
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'PROJECT_RENDER_FAILED', message: 'Project rendering failed.' };
    }
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

  private remove(projectId: string, renderJobId: string): void {
    const key = this.key(projectId, renderJobId);
    const job = this.jobs.get(key);
    if (!job) return;
    clearTimeout(job.cleanupTimer);
    this.jobs.delete(key);
    if (this.projectJobs.get(projectId) === renderJobId) this.projectJobs.delete(projectId);
  }

  private key(projectId: string, renderJobId: string): string { return `${projectId}:${renderJobId}`; }
}
