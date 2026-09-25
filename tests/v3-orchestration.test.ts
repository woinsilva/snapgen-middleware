import { describe, expect, it, vi } from 'vitest';
import { SnapGenError } from '../src/errors.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { projectInput, serviceWith, testSceneReferences } from './v3.helpers.js';
import { StatelessProjectService } from '../src/projects/project.service.js';
import { testTokens } from './v3.helpers.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';

function provider(overrides: Partial<VideoProvider> = {}): VideoProvider {
  return {
    generateVideo: vi.fn(async () => ({ uuid, status: 'processing', provider: 'snapgen', model: 'veo-3.1-fast' })),
    getVideo: vi.fn(async () => ({ uuid, status: 'processing', progress: 20, videoUrl: null, provider: 'snapgen' })),
    extendVideo: vi.fn(),
    createStoryboard: vi.fn(),
    ...overrides,
  };
}

describe('V3 stateless command/query orchestration', () => {
  it('keeps every returned token valid through the observed two-scene lifecycle', async () => {
    const scene1 = '550e8400-e29b-41d4-a716-446655440001';
    const scene2 = '550e8400-e29b-41d4-a716-446655440002';
    const mock = provider({
      generateVideo: vi.fn()
        .mockResolvedValueOnce({ uuid: scene1, status: 'processing', provider: 'snapgen', model: 'veo-3.1-fast' })
        .mockResolvedValueOnce({ uuid: scene2, status: 'processing', provider: 'snapgen', model: 'veo-3.1-fast' }),
      getVideo: vi.fn()
        .mockResolvedValueOnce({ uuid: scene1, status: 'processing', progress: 50, videoUrl: null, provider: 'snapgen' })
        .mockResolvedValueOnce({ uuid: scene1, status: 'completed', progress: 100, videoUrl: 'https://cdn.example/scene-1.mp4', provider: 'snapgen' })
        .mockResolvedValueOnce({ uuid: scene2, status: 'processing', progress: 25, videoUrl: null, provider: 'snapgen' }),
    });
    const { service } = serviceWith(mock);
    const tokens: string[] = [];
    const accept = (projectState: string) => {
      expect(() => service.verify(projectState)).not.toThrow();
      if (tokens.length) expect(projectState).not.toBe(tokens.at(-1));
      tokens.push(projectState);
      return projectState;
    };

    let latest = accept(service.start(projectInput()).projectState);
    latest = accept((await service.advance(latest, 'start-scene-1')).projectState);
    latest = accept((await service.status(latest, 'poll-scene-1-processing')).projectState);
    latest = accept((await service.status(latest, 'poll-scene-1-completed')).projectState);
    latest = accept((await service.advance(latest, 'start-scene-2')).projectState);
    latest = accept((await service.status(latest, 'poll-scene-2-processing')).projectState);

    const state = service.verify(latest);
    expect(state.scenes[0]).toMatchObject({ status: 'completed', snapgenUuid: scene1 });
    expect(state.scenes[1]).toMatchObject({ status: 'processing', snapgenUuid: scene2 });
    expect(state.scenes.slice(2).every((scene) => scene.status === 'pending')).toBe(true);
    expect(state.paidOperations).toBe(2);
    expect(mock.generateVideo).toHaveBeenCalledTimes(2);
    expect(mock.generateVideo).toHaveBeenNthCalledWith(2, expect.objectContaining({
      mode_image: 'frame',
      ref_images: ['https://middleware.example/continuity/scene-1.png'],
      prompt: expect.stringContaining('exact final frame of the previous scene'),
    }), 'start-scene-2');
    expect(mock.getVideo).toHaveBeenCalledTimes(3);

    const tampered = `${latest.slice(0, -1)}${latest.endsWith('x') ? 'y' : 'x'}`;
    expect(() => service.verify(tampered)).toThrow('invalid or has been modified');
  });

  it('starts without a paid provider call', () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const response = service.start(projectInput());
    expect(response.status).toBe('planning');
    expect(response.scenes).toEqual({ total: 9, completed: 0, processing: 0, pending: 9 });
    expect(mock.generateVideo).not.toHaveBeenCalled();
  });

  it('moves the first scene to processing without a reference frame', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const response = await service.advance(service.start(projectInput()).projectState, 'request-1');
    const state = service.verify(response.projectState);
    expect(state.generationStrategy).toBe('last-frame-chained');
    expect(mock.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ ref_images: [] }), 'request-1');
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
    expect(mock.extendVideo).not.toHaveBeenCalled();
    expect(state.scenes[0]).toMatchObject({ status: 'processing', attemptNumber: 1, operation: 'generate', snapgenUuid: uuid });
    expect(state.paidOperations).toBe(1);
  });

  it('polls an existing UUID without another generation POST', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const processing = await service.advance(service.start(projectInput()).projectState, 'request-1');
    vi.mocked(mock.generateVideo).mockClear();
    const result = await service.status(processing.projectState, 'request-2');
    expect(mock.getVideo).toHaveBeenCalledWith(uuid, 'request-2');
    expect(mock.generateVideo).not.toHaveBeenCalled();
    expect(service.verify(result.projectState).scenes[0]?.snapgenUuid).toBe(uuid);
  });

  it('uses at most one non-retrying provider lookup per status call', async () => {
    const getVideo = vi.fn(async () => ({ uuid, status: 'processing' as const, progress: 20, videoUrl: null, provider: 'snapgen' as const }));
    const getVideoOnce = vi.fn(async () => ({ uuid, status: 'processing' as const, progress: 20, videoUrl: null, provider: 'snapgen' as const }));
    const mock = provider({ getVideo, getVideoOnce });
    const { service } = serviceWith(mock);
    const processing = await service.advance(service.start(projectInput()).projectState, 'advance');
    vi.mocked(mock.generateVideo).mockClear();

    await service.status(processing.projectState, 'status');

    expect(getVideoOnce).toHaveBeenCalledTimes(1);
    expect(getVideo).not.toHaveBeenCalled();
    expect(mock.generateVideo).not.toHaveBeenCalled();
  });

  it('status with no processing scene is read-only and returns the same valid token', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const started = service.start(projectInput());

    const result = await service.status(started.projectState, 'status');

    expect(result.projectState).toBe(started.projectState);
    expect(() => service.verify(result.projectState)).not.toThrow();
    expect(mock.getVideo).not.toHaveBeenCalled();
    expect(mock.generateVideo).not.toHaveBeenCalled();
  });

  it('advance rejects while a scene is processing without polling or starting another scene', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const processing = await service.advance(service.start(projectInput()).projectState, 'first-advance');
    vi.mocked(mock.generateVideo).mockClear();

    await expect(service.advance(processing.projectState, 'blocked-advance')).rejects.toMatchObject({
      status: 409,
      code: 'PROJECT_STATUS_REQUIRED',
    });
    expect(mock.generateVideo).not.toHaveBeenCalled();
    expect(mock.getVideo).not.toHaveBeenCalled();
  });

  it('marks a polled scene completed and advances only on a later call', async () => {
    const mock = provider({ getVideo: vi.fn(async () => ({ uuid, status: 'completed', progress: 100, videoUrl: 'https://cdn.example/video.mp4', provider: 'snapgen' })) });
    const { service } = serviceWith(mock);
    const processing = await service.advance(service.start(projectInput()).projectState, 'request-1');
    vi.mocked(mock.generateVideo).mockClear();
    const completed = await service.status(processing.projectState, 'request-2');
    expect(service.verify(completed.projectState).scenes[0]?.status).toBe('completed');
    expect(mock.generateVideo).not.toHaveBeenCalled();
    await service.advance(completed.projectState, 'request-3');
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('fails safely when status polling reports provider failure', async () => {
    const mock = provider({ getVideo: vi.fn(async () => ({ uuid, status: 'failed', progress: 100, videoUrl: null, provider: 'snapgen', error: 'rejected' })) });
    const { service } = serviceWith(mock);
    const processing = await service.advance(service.start(projectInput()).projectState, 'request-1');
    const failed = await service.status(processing.projectState, 'request-2');
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PROVIDER_GENERATION_FAILED');
  });

  it('preserves the usable input token when a read-only provider lookup fails', async () => {
    const getVideoOnce = vi.fn(async () => { throw new SnapGenError(503, { message: 'provider unavailable' }); });
    const mock = provider({ getVideoOnce });
    const { service } = serviceWith(mock);
    const processing = await service.advance(service.start(projectInput()).projectState, 'advance');

    await expect(service.status(processing.projectState, 'status')).rejects.toMatchObject({ status: 503 });
    expect(() => service.verify(processing.projectState)).not.toThrow();
    expect(getVideoOnce).toHaveBeenCalledTimes(1);
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('marks a timed-out POST ambiguous, consumes budget and never retries', async () => {
    const mock = provider({ generateVideo: vi.fn(async () => { throw new SnapGenError(504, undefined, 'SnapGen request timeout'); }) });
    const { service } = serviceWith(mock);
    const failed = await service.advance(service.start(projectInput()).projectState, 'request-1');
    const state = service.verify(failed.projectState);
    expect(failed.error).toMatchObject({ code: 'AMBIGUOUS_PROVIDER_SUBMISSION', retryable: false });
    expect(state.paidOperations).toBe(1);
    await service.advance(failed.projectState, 'request-2');
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('conservatively treats a provider 5xx without UUID as ambiguous', async () => {
    const mock = provider({ generateVideo: vi.fn(async () => { throw new SnapGenError(503, { message: 'provider unavailable' }); }) });
    const { service } = serviceWith(mock);
    const failed = await service.advance(service.start(projectInput()).projectState, 'request-1');
    expect(failed.error?.code).toBe('AMBIGUOUS_PROVIDER_SUBMISSION');
    expect(service.verify(failed.projectState).paidOperations).toBe(1);
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('blocks a new POST when the signed budget is exhausted', async () => {
    const mock = provider();
    const { service, tokens } = serviceWith(mock);
    const state = service.verify(service.start(projectInput()).projectState);
    state.paidOperations = state.maxPaidOperations;
    const result = await service.advance(tokens.sign(state), 'request-1');
    expect(result.error?.code).toBe('PAID_OPERATION_BUDGET_EXHAUSTED');
    expect(mock.generateVideo).not.toHaveBeenCalled();
  });

  it('transitions an all-completed generating state to assembling without rendering or generation', async () => {
    const mock = provider();
    const { service, tokens } = serviceWith(mock);
    const state = service.verify(service.start(projectInput()).projectState);
    state.status = 'generating';
    state.scenes.forEach((scene, index) => {
      scene.status = 'completed';
      scene.attemptNumber = 1;
      scene.snapgenUuid = `550e8400-e29b-41d4-a716-${String(446655440000 + index).padStart(12, '0')}`;
    });

    const result = await service.advance(tokens.sign(state), 'advance');

    expect(result.status).toBe('assembling');
    expect(mock.generateVideo).not.toHaveBeenCalled();
    expect(mock.getVideo).not.toHaveBeenCalled();
  });

  it('documents that replaying an old pending token cannot be detected statelessly', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const oldToken = service.start(projectInput()).projectState;
    await service.advance(oldToken, 'request-1');
    await service.advance(oldToken, 'request-2');
    expect(mock.generateVideo).toHaveBeenCalledTimes(2);
  });

  it('retains legacy continue semantics for existing runtime consumers', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const started = service.start(projectInput());
    const processing = await service.continue(started.projectState, 'legacy-advance');
    const polled = await service.continue(processing.projectState, 'legacy-status');

    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
    expect(mock.getVideo).toHaveBeenCalledTimes(1);
    expect(service.verify(polled.projectState).scenes[0]?.snapgenUuid).toBe(uuid);
  });

  it('accepts an in-progress schema-2 token issued through the legacy contract in the new status action', async () => {
    const mock = provider();
    const now = new Date('2026-09-14T12:00:00.000Z');
    const legacy = new StatelessProjectService(testTokens(now), mock, undefined, 86_400, () => now);
    const processing = await legacy.continue(legacy.start(projectInput()).projectState, 'legacy-advance');
    const current = new StatelessProjectService(testTokens(now), mock, undefined, 86_400, () => now);

    const result = await current.status(processing.projectState, 'new-status');

    expect(result.status).toBe('generating');
    expect(() => current.verify(result.projectState)).not.toThrow();
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
    expect(mock.getVideo).toHaveBeenCalledTimes(1);
  });

  it('renders only after all scenes complete and returns ephemeral output metadata', async () => {
    let generated = 0;
    const mock = provider({
      generateVideo: vi.fn(async () => ({
        uuid: `550e8400-e29b-41d4-a716-${String(446655440000 + generated++).padStart(12, '0')}`,
        status: 'processing', provider: 'snapgen', model: 'veo-3.1-fast',
      })),
      getVideo: vi.fn(async (sceneUuid) => ({ uuid: sceneUuid, status: 'completed', progress: 100, videoUrl: 'https://cdn.example/video.mp4', provider: 'snapgen' })),
    });
    const renderer = { render: vi.fn(async () => ({ handle: '7d9f6f50-18a1-4ff0-bd1f-5a83639928ad', expiresAt: '2026-09-14T12:15:00.000Z' })) };
    const now = new Date('2026-09-14T12:00:00.000Z');
    const service = new StatelessProjectService(testTokens(now), mock, renderer, 86_400, () => now, testSceneReferences);
    let response = service.start(projectInput());
    for (let scene = 0; scene < 9; scene += 1) {
      response = await service.advance(response.projectState, `submit-${scene}`);
      response = await service.status(response.projectState, `poll-${scene}`);
    }
    expect(response.status).toBe('assembling');
    expect(renderer.render).not.toHaveBeenCalled();
    response = await service.render(response.projectState, 'render-request');
    expect(response.status).toBe('completed');
    expect(service.verify(response.projectState).generationStrategy).toBe('last-frame-chained');
    expect(response.progress).toBe(100);
    expect(response.downloadUrl).toContain('/video/projects/output/');
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});
