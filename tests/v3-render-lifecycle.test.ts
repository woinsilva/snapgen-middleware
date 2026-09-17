import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/errors.js';
import { RenderJobManager } from '../src/projects/render-job.manager.js';
import { StatelessProjectService, type ProjectRenderer, type RenderResult } from '../src/projects/project.service.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import type { Logger } from '../src/utils/logger.js';
import { projectInput, testTokens } from './v3.helpers.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
const provider = {
  generateVideo: vi.fn(), getVideo: vi.fn(), extendVideo: vi.fn(), createStoryboard: vi.fn(),
} as VideoProvider;

function ready(renderer: ProjectRenderer) {
  const tokens = testTokens();
  const service = new StatelessProjectService(tokens, provider, renderer, 86_400, () => new Date('2026-09-14T12:00:00.000Z'));
  const state = service.verify(service.start(projectInput()).projectState);
  state.status = 'assembling';
  state.progress = 90;
  state.scenes.forEach((scene) => { scene.status = 'completed'; scene.attemptNumber = 1; scene.snapgenUuid = uuid; });
  return { service, projectState: tokens.sign(state), projectId: state.projectId };
}

function deferredRenderer() {
  let resolve!: (value: RenderResult) => void;
  let reject!: (error: Error) => void;
  const renderer: ProjectRenderer = { render: vi.fn(() => new Promise<RenderResult>((res, rej) => { resolve = res; reject = rej; })) };
  return { renderer, resolve: (value: RenderResult) => resolve(value), reject: (error: Error) => reject(error) };
}

function outputAfter(seconds: number): RenderResult {
  return { handle: '7d9f6f50-18a1-4ff0-bd1f-5a83639928ad', expiresAt: new Date(Date.now() + seconds * 1_000).toISOString() };
}

async function startBackground(): Promise<void> { await vi.advanceTimersByTimeAsync(0); }

describe('hardened ephemeral render lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('never applies terminal retention TTL to a processing job', async () => {
    const pending = deferredRenderer();
    const fixture = ready(pending.renderer);
    const manager = new RenderJobManager(fixture.service, 'https://video.example.test', 1, 100, undefined, () => new Date());
    const job = manager.start(fixture.projectState, 'processing');
    await startBackground();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.get(fixture.projectId, job.renderJobId).status).toBe('processing');
  });

  it('starts terminal retention only after completion and clears timers on cleanup', async () => {
    const pending = deferredRenderer();
    const records: Record<string, unknown>[] = [];
    const logger: Logger = { info: (record) => records.push(record), error: (record) => records.push(record) };
    const fixture = ready(pending.renderer);
    const manager = new RenderJobManager(fixture.service, 'https://video.example.test', 1, 100, logger, () => new Date());
    const job = manager.start(fixture.projectState, 'completed');
    await startBackground();
    expect(vi.getTimerCount()).toBe(1);
    pending.resolve(outputAfter(900));
    await startBackground();
    expect(manager.get(fixture.projectId, job.renderJobId).status).toBe('completed');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(manager.get(fixture.projectId, job.renderJobId).status).toBe('completed');
    await vi.advanceTimersByTimeAsync(1);
    expect(() => manager.get(fixture.projectId, job.renderJobId)).toThrowError(ApiError);
    expect(vi.getTimerCount()).toBe(0);
    expect(records).toContainEqual(expect.objectContaining({ event: 'render_job_cleaned', cleanupReason: 'terminal_ttl_expired' }));
  });

  it('retains failed jobs for the terminal TTL', async () => {
    const renderer: ProjectRenderer = { render: vi.fn(async () => { throw new Error('synthetic'); }) };
    const fixture = ready(renderer);
    const manager = new RenderJobManager(fixture.service, 'https://video.example.test', 2, 100, undefined, () => new Date());
    const job = manager.start(fixture.projectState, 'failed');
    await startBackground();
    expect(manager.get(fixture.projectId, job.renderJobId).status).toBe('failed');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(manager.get(fixture.projectId, job.renderJobId).status).toBe('failed');
    await vi.advanceTimersByTimeAsync(1);
    expect(() => manager.get(fixture.projectId, job.renderJobId)).toThrowError(/not found or has expired/);
  });

  it('times out execution, remains observable, aborts work, and ignores late completion', async () => {
    const pending = deferredRenderer();
    const fixture = ready(pending.renderer);
    const manager = new RenderJobManager(fixture.service, 'https://video.example.test', 10, 1, undefined, () => new Date());
    const job = manager.start(fixture.projectState, 'timeout');
    await startBackground();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.get(fixture.projectId, job.renderJobId)).toMatchObject({ status: 'failed', error: { code: 'RENDER_EXECUTION_TIMEOUT' } });
    const options = vi.mocked(pending.renderer.render).mock.calls[0]?.[2];
    expect(options?.signal?.aborted).toBe(true);
    pending.resolve(outputAfter(900));
    await startBackground();
    expect(manager.get(fixture.projectId, job.renderJobId)).toMatchObject({ status: 'failed', downloadUrl: null, error: { code: 'RENDER_EXECUTION_TIMEOUT' } });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(manager.get(fixture.projectId, job.renderJobId).status).toBe('failed');
  });

  it('represents output expiry safely while retaining terminal metadata', async () => {
    const renderer: ProjectRenderer = { render: vi.fn(async () => outputAfter(900)) };
    const fixture = ready(renderer);
    const manager = new RenderJobManager(fixture.service, 'https://video.example.test', 1_200, 100, undefined, () => new Date());
    const job = manager.start(fixture.projectState, 'expiry');
    await startBackground();
    const completed = manager.get(fixture.projectId, job.renderJobId);
    expect(completed.status).toBe('completed');
    expect(completed.downloadUrl).toContain('?access=');
    await vi.advanceTimersByTimeAsync(900_001);
    expect(manager.get(fixture.projectId, job.renderJobId)).toMatchObject({ status: 'failed', downloadUrl: null, error: { code: 'OUTPUT_EXPIRED' } });
  });

  it('still loses instance-local metadata in a new manager and never recovers automatically', async () => {
    const pending = deferredRenderer();
    const fixture = ready(pending.renderer);
    const first = new RenderJobManager(fixture.service, 'https://video.example.test', 100, 200, undefined, () => new Date());
    const job = first.start(fixture.projectState, 'old-process');
    await startBackground();
    const replacement = new RenderJobManager(fixture.service, 'https://video.example.test', 100, 200, undefined, () => new Date());
    expect(() => replacement.get(fixture.projectId, job.renderJobId)).toThrowError(/not found or has expired/);
    expect(pending.renderer.render).toHaveBeenCalledTimes(1);
  });

  it('interrupts processing jobs and refuses new jobs during shutdown', async () => {
    const pending = deferredRenderer();
    const fixture = ready(pending.renderer);
    const manager = new RenderJobManager(fixture.service, 'https://video.example.test', 100, 200, undefined, () => new Date());
    const job = manager.start(fixture.projectState, 'shutdown');
    await startBackground();
    expect(manager.beginShutdown()).toEqual({ active: 1, total: 1 });
    expect(manager.get(fixture.projectId, job.renderJobId)).toMatchObject({ status: 'failed', error: { code: 'RENDER_INTERRUPTED' } });
    expect(() => manager.start(fixture.projectState, 'rejected')).toThrowError(/not accepted during shutdown/);
  });
});
