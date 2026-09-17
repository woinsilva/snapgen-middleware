import { describe, expect, it, vi } from 'vitest';
import { SnapGenError } from '../src/errors.js';
import { GenerationJobManager, type GenerationJobResponse } from '../src/projects/generation-job.manager.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { projectInput, serviceWith } from './v3.helpers.js';

const uuids = Array.from({ length: 9 }, (_, index) => `550e8400-e29b-41d4-a716-${String(446655440000 + index)}`);

function provider(overrides: Partial<VideoProvider> = {}): VideoProvider {
  let submission = 0;
  return {
    generateVideo: vi.fn(async (input) => ({ uuid: uuids[submission++]!, status: 'processing', provider: 'snapgen', model: input.model })),
    getVideo: vi.fn(),
    getVideoOnce: vi.fn(async (uuid) => ({ uuid, status: 'completed', progress: 100, videoUrl: `https://media.example/${uuid}.mp4`, provider: 'snapgen' })),
    extendVideo: vi.fn(),
    createStoryboard: vi.fn(),
    ...overrides,
  };
}

async function terminal(manager: GenerationJobManager, started: GenerationJobResponse): Promise<GenerationJobResponse> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = manager.get(started.projectId, started.generationJobId);
    if (current.status !== 'processing') return current;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Generation job did not reach a terminal state');
}

describe('V3.1 asynchronous whole-project generation jobs', () => {
  it('starts with 202-compatible state, is idempotent in-process, and generates strictly sequentially', async () => {
    const events: string[] = [];
    let submission = 0;
    const mock = provider({
      generateVideo: vi.fn(async (input) => {
        const uuid = uuids[submission++]!;
        events.push(`post:${submission}`);
        return { uuid, status: 'processing', provider: 'snapgen', model: input.model };
      }),
      getVideoOnce: vi.fn(async (uuid) => {
        const scene = uuids.indexOf(uuid) + 1;
        events.push(`get:${scene}`);
        return { uuid, status: 'completed', progress: 100, videoUrl: `https://media.example/${uuid}.mp4`, provider: 'snapgen' };
      }),
    });
    const { service } = serviceWith(mock);
    const manager = new GenerationJobManager(service, { sleep: async () => undefined, pollInitialMs: 1, pollMaximumMs: 2 });
    const project = service.start(projectInput());

    const started = manager.start(project.projectState, 'job');
    const duplicate = manager.start(project.projectState, 'duplicate');
    expect(started.generationJobId).toBe(duplicate.generationJobId);
    expect(started.status).toBe('processing');
    expect(started.maxPaidOperations).toBe(9);
    expect(service.verify(started.projectState).scenes[0]?.status).toBe('submitting');

    const completed = await terminal(manager, started);
    expect(completed.status).toBe('assembling');
    expect(completed.scenes).toEqual({ total: 9, completed: 9, processing: 0, pending: 0 });
    expect(mock.generateVideo).toHaveBeenCalledTimes(9);
    expect(mock.getVideoOnce).toHaveBeenCalledTimes(9);
    expect(events).toEqual(Array.from({ length: 9 }, (_, index) => [`post:${index + 1}`, `get:${index + 1}`]).flat());
    const latest = service.verify(completed.projectState);
    expect(latest.status).toBe('assembling');
    expect(latest.paidOperations).toBe(9);
    expect(latest.schemaVersion).toBe(2);
  });

  it('does not regenerate a completed scene and authorizes only remaining paid operations', async () => {
    const mock = provider();
    const { service, tokens } = serviceWith(mock);
    const state = service.verify(service.start(projectInput()).projectState);
    state.status = 'generating';
    state.scenes[0]!.status = 'completed';
    state.scenes[0]!.attemptNumber = 1;
    state.scenes[0]!.snapgenUuid = uuids[0];
    state.paidOperations = 1;
    const manager = new GenerationJobManager(service, { sleep: async () => undefined });

    const started = manager.start(tokens.sign(state), 'remaining');
    expect(started.maxPaidOperations).toBe(8);
    const completed = await terminal(manager, started);
    expect(completed.status).toBe('assembling');
    expect(mock.generateVideo).toHaveBeenCalledTimes(8);
    expect(service.verify(completed.projectState).scenes[0]?.snapgenUuid).toBe(uuids[0]);
  });

  it('stops on an ambiguous paid POST and never retries it', async () => {
    const mock = provider({ generateVideo: vi.fn(async () => { throw new SnapGenError(504, undefined, 'timeout'); }) });
    const { service } = serviceWith(mock);
    const manager = new GenerationJobManager(service, { sleep: async () => undefined });
    const started = manager.start(service.start(projectInput()).projectState, 'ambiguous');

    const failed = await terminal(manager, started);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('AMBIGUOUS_PROVIDER_SUBMISSION');
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
    expect(mock.getVideoOnce).not.toHaveBeenCalled();
    const state = service.verify(failed.projectState);
    expect(state.scenes[0]?.status).toBe('ambiguous');
    expect(state.paidOperations).toBe(1);
  });

  it('polling never submits again and bounded polling fails safely', async () => {
    const mock = provider({
      getVideoOnce: vi.fn(async (uuid) => ({ uuid, status: 'processing', progress: 10, videoUrl: null, provider: 'snapgen' })),
    });
    const { service } = serviceWith(mock);
    const manager = new GenerationJobManager(service, { sleep: async () => undefined, maxPollsPerScene: 3 });
    const started = manager.start(service.start(projectInput()).projectState, 'poll-limit');

    const failed = await terminal(manager, started);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('GENERATION_JOB_POLL_LIMIT');
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
    expect(mock.getVideoOnce).toHaveBeenCalledTimes(3);
  });

  it('blocks manual advance during a job and a new manager cannot reconstruct a lost job', () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const manager = new GenerationJobManager(service, { sleep: () => new Promise(() => undefined) });
    const original = service.start(projectInput()).projectState;
    const started = manager.start(original, 'active');

    expect(() => manager.assertManualAdvanceAllowed(original)).toThrowError(/disabled while/);
    const afterRestart = new GenerationJobManager(service);
    expect(() => afterRestart.get(started.projectId, started.generationJobId)).toThrowError(/lost after restart/);
    expect(mock.generateVideo).not.toHaveBeenCalled();
  });

  it('expires safely without starting the next scene', async () => {
    let now = 0;
    const mock = provider({
      getVideoOnce: vi.fn(async (uuid) => ({ uuid, status: 'processing', progress: 10, videoUrl: null, provider: 'snapgen' })),
    });
    const { service } = serviceWith(mock);
    const manager = new GenerationJobManager(service, {
      jobTtlSeconds: 1,
      now: () => now,
      sleep: async () => { now = 1_001; },
    });
    const started = manager.start(service.start(projectInput()).projectState, 'expires');

    const failed = await terminal(manager, started);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('GENERATION_JOB_EXPIRED');
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
    expect(mock.getVideoOnce).not.toHaveBeenCalled();
  });

  it('start project itself consumes zero provider operations and rendering is not started by generation', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const project = service.start(projectInput());
    expect(mock.generateVideo).not.toHaveBeenCalled();
    const manager = new GenerationJobManager(service, { sleep: async () => undefined });
    const result = await terminal(manager, manager.start(project.projectState, 'job'));
    expect(result.status).toBe('assembling');
    expect(result).not.toHaveProperty('renderJobId');
  });

  it('emits safe lifecycle logs and fails processing work observably on shutdown', async () => {
    const records: Record<string, unknown>[] = [];
    const mock = provider();
    const { service } = serviceWith(mock);
    const manager = new GenerationJobManager(service, {
      sleep: () => new Promise(() => undefined),
      logger: { info: (record) => records.push(record), error: (record) => records.push(record) },
    });
    const project = service.start(projectInput());
    const started = manager.start(project.projectState, 'shutdown-observability');
    expect(manager.beginShutdown()).toEqual({ active: 1, total: 1 });
    expect(manager.get(started.projectId, started.generationJobId)).toMatchObject({ status: 'failed', error: { code: 'GENERATION_JOB_INTERRUPTED' } });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'generation_job_created', generationJobId: started.generationJobId }),
      expect.objectContaining({ event: 'generation_scene_reserved', sceneSequence: 1 }),
      expect.objectContaining({ event: 'generation_job_interrupted', errorCode: 'GENERATION_JOB_INTERRUPTED' }),
      expect.objectContaining({ event: 'generation_job_failed', errorCode: 'GENERATION_JOB_INTERRUPTED' }),
    ]));
    expect(JSON.stringify(records)).not.toContain(project.projectState);
  });
});
