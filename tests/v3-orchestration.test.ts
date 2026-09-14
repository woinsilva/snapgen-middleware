import { describe, expect, it, vi } from 'vitest';
import { SnapGenError } from '../src/errors.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { projectInput, serviceWith } from './v3.helpers.js';
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

describe('V3 stateless continuation', () => {
  it('starts without a paid provider call', () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const response = service.start(projectInput());
    expect(response.status).toBe('planning');
    expect(response.scenes).toEqual({ total: 9, completed: 0, processing: 0, pending: 9 });
    expect(mock.generateVideo).not.toHaveBeenCalled();
  });

  it('moves pending to processing with exactly one independent generation POST', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const response = await service.continue(service.start(projectInput()).projectState, 'request-1');
    const state = service.verify(response.projectState);
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
    expect(mock.extendVideo).not.toHaveBeenCalled();
    expect(state.scenes[0]).toMatchObject({ status: 'processing', attemptNumber: 1, operation: 'generate', snapgenUuid: uuid });
    expect(state.paidOperations).toBe(1);
  });

  it('polls an existing UUID without another generation POST', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const processing = await service.continue(service.start(projectInput()).projectState, 'request-1');
    vi.mocked(mock.generateVideo).mockClear();
    const result = await service.continue(processing.projectState, 'request-2');
    expect(mock.getVideo).toHaveBeenCalledWith(uuid, 'request-2');
    expect(mock.generateVideo).not.toHaveBeenCalled();
    expect(service.verify(result.projectState).scenes[0]?.snapgenUuid).toBe(uuid);
  });

  it('marks a polled scene completed and advances only on a later call', async () => {
    const mock = provider({ getVideo: vi.fn(async () => ({ uuid, status: 'completed', progress: 100, videoUrl: 'https://cdn.example/video.mp4', provider: 'snapgen' })) });
    const { service } = serviceWith(mock);
    const processing = await service.continue(service.start(projectInput()).projectState, 'request-1');
    vi.mocked(mock.generateVideo).mockClear();
    const completed = await service.continue(processing.projectState, 'request-2');
    expect(service.verify(completed.projectState).scenes[0]?.status).toBe('completed');
    expect(mock.generateVideo).not.toHaveBeenCalled();
    await service.continue(completed.projectState, 'request-3');
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('fails safely when status polling reports provider failure', async () => {
    const mock = provider({ getVideo: vi.fn(async () => ({ uuid, status: 'failed', progress: 100, videoUrl: null, provider: 'snapgen', error: 'rejected' })) });
    const { service } = serviceWith(mock);
    const processing = await service.continue(service.start(projectInput()).projectState, 'request-1');
    const failed = await service.continue(processing.projectState, 'request-2');
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PROVIDER_GENERATION_FAILED');
  });

  it('marks a timed-out POST ambiguous, consumes budget and never retries', async () => {
    const mock = provider({ generateVideo: vi.fn(async () => { throw new SnapGenError(504, undefined, 'SnapGen request timeout'); }) });
    const { service } = serviceWith(mock);
    const failed = await service.continue(service.start(projectInput()).projectState, 'request-1');
    const state = service.verify(failed.projectState);
    expect(failed.error).toMatchObject({ code: 'AMBIGUOUS_PROVIDER_SUBMISSION', retryable: false });
    expect(state.paidOperations).toBe(1);
    await service.continue(failed.projectState, 'request-2');
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('conservatively treats a provider 5xx without UUID as ambiguous', async () => {
    const mock = provider({ generateVideo: vi.fn(async () => { throw new SnapGenError(503, { message: 'provider unavailable' }); }) });
    const { service } = serviceWith(mock);
    const failed = await service.continue(service.start(projectInput()).projectState, 'request-1');
    expect(failed.error?.code).toBe('AMBIGUOUS_PROVIDER_SUBMISSION');
    expect(service.verify(failed.projectState).paidOperations).toBe(1);
    expect(mock.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('blocks a new POST when the signed budget is exhausted', async () => {
    const mock = provider();
    const { service, tokens } = serviceWith(mock);
    const state = service.verify(service.start(projectInput()).projectState);
    state.paidOperations = state.maxPaidOperations;
    const result = await service.continue(tokens.sign(state), 'request-1');
    expect(result.error?.code).toBe('PAID_OPERATION_BUDGET_EXHAUSTED');
    expect(mock.generateVideo).not.toHaveBeenCalled();
  });

  it('documents that replaying an old pending token cannot be detected statelessly', async () => {
    const mock = provider();
    const { service } = serviceWith(mock);
    const oldToken = service.start(projectInput()).projectState;
    await service.continue(oldToken, 'request-1');
    await service.continue(oldToken, 'request-2');
    expect(mock.generateVideo).toHaveBeenCalledTimes(2);
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
    const service = new StatelessProjectService(testTokens(now), mock, renderer, 86_400, () => now);
    let response = service.start(projectInput());
    for (let scene = 0; scene < 9; scene += 1) {
      response = await service.continue(response.projectState, `submit-${scene}`);
      response = await service.continue(response.projectState, `poll-${scene}`);
    }
    expect(response.status).toBe('assembling');
    expect(renderer.render).not.toHaveBeenCalled();
    response = await service.render(response.projectState, 'render-request');
    expect(response.status).toBe('completed');
    expect(response.progress).toBe(100);
    expect(response.downloadUrl).toContain('/video/projects/output/');
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});
