import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import { SnapGenService } from '../src/services/snapgen.service.js';

const generationUuid = '550e8400-e29b-41d4-a716-446655440000';
const env: AppEnv = {
  NODE_ENV: 'test', PORT: 3000, SNAPGEN_API_KEY: 'snapgen-secret', MIDDLEWARE_API_KEY: 'middleware-secret',
  SNAPGEN_TIMEOUT_MS: 1000, ALLOWED_ORIGINS: '*', SNAPGEN_BASE_URL: 'https://api.snapgen.ai',
  RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX: 100, LOG_LEVEL: 'silent',
};

afterEach(() => vi.restoreAllMocks());

function appWithFetch(fetchMock: typeof fetch, overrides: Partial<AppEnv> = {}) {
  const testEnv = { ...env, ...overrides };
  return createApp(testEnv, new SnapGenService(testEnv, fetchMock));
}

function success(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('middleware API', () => {
  it('returns health without authentication', async () => {
    const response = await request(createApp(env)).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('uses a supplied request ID in the response and SnapGen call', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect((init?.headers as Record<string, string>)['x-request-id']).toBe('trace-from-gpt');
      return success({
        id: 2588,
        uuid: generationUuid,
        user_id: 3,
        model_name: 'veo-3.1-fast',
        input_text: 'A cinematic lake',
        type: 'video',
        status: 1,
        status_percentage: 1,
      });
    });
    const response = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).set('x-request-id', 'trace-from-gpt')
      .send({ prompt: 'A cinematic lake', model: 'veo-3.1-fast' });
    expect(response.header['x-request-id']).toBe('trace-from-gpt');
  });

  it('generates and returns a request ID when absent', async () => {
    const response = await request(createApp(env)).get('/health');
    expect(response.header['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('rejects a missing middleware API key', async () => {
    const response = await request(createApp(env)).get(`/video/${generationUuid}`);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns validation details for an invalid generation request', async () => {
    const response = await request(createApp(env)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).send({ prompt: '', model: 'unknown' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation error');
    expect(response.body.details).toEqual(expect.any(Array));
  });

  it('converts JSON fields to native FormData without setting Content-Type manually', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.snapgen.ai/uapi/v1/video-gen/veo');
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('prompt')).toBe('A cinematic lake');
      expect(form.get('model')).toBe('veo-3.1-fast');
      expect(form.get('duration')).toBe('8');
      expect(form.get('resolution')).toBe('720p');
      expect(form.get('aspect_ratio')).toBe('16:9');
      expect(form.get('mode_image')).toBe('frame');
      expect(form.getAll('ref_images')).toEqual(['https://example.com/start.png', 'https://example.com/end.png']);
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(env.SNAPGEN_API_KEY);
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('content-type');
      return success({ uuid: generationUuid, status: 1 });
    });

    const response = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).send({
        prompt: 'A cinematic lake', model: 'veo-3.1-fast', duration: 8, resolution: '720p', aspect_ratio: '16:9',
        mode_image: 'frame', ref_images: ['https://example.com/start.png', 'https://example.com/end.png'],
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ uuid: generationUuid, status: 'processing', provider: 'snapgen', model: 'veo-3.1-fast' });
  });

  it('accepts a valid creation UUID without applying the history status mapper', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => success({ conversion_uuid: generationUuid, status: 'queued' }));
    const response = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY)
      .send({ prompt: 'A cinematic lake', model: 'veo-3.1-fast' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ uuid: generationUuid, status: 'processing', provider: 'snapgen', model: 'veo-3.1-fast' });
  });

  it.each([401, 422, 429, 500])('preserves SnapGen HTTP %i errors and redacts secrets', async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      detail: { message: `bad ${env.SNAPGEN_API_KEY}`, api_key: env.SNAPGEN_API_KEY },
    }), { status }));
    const response = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).send({ prompt: 'A cinematic lake', model: 'veo-3.1-fast' });
    expect(response.status).toBe(status);
    expect(response.body.error).toBe('SnapGen request failed');
    expect(JSON.stringify(response.body)).not.toContain(env.SNAPGEN_API_KEY);
    expect(response.body.details.detail.api_key).toBe('[REDACTED]');
  });

  it('returns the documented 504 response when SnapGen times out', async () => {
    const fetchMock = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const response = await request(appWithFetch(fetchMock, { SNAPGEN_TIMEOUT_MS: 5 })).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).send({ prompt: 'A cinematic lake', model: 'veo-3.1-fast' });
    expect(response.status).toBe(504);
    expect(response.body).toEqual({ error: 'SnapGen request timeout' });
  });

  it('normalizes a processing status', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => success({ uuid: generationUuid, status: 1, status_percentage: 40 }));
    const response = await request(appWithFetch(fetchMock)).get(`/video/${generationUuid}`).set('x-api-key', env.MIDDLEWARE_API_KEY);
    expect(response.body).toEqual({ uuid: generationUuid, status: 'processing', progress: 40, videoUrl: null, provider: 'snapgen' });
  });

  it('normalizes a completed status and documented generated_video URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => success({ uuid: generationUuid, status: 2, status_percentage: 100,
      generated_video: [{ video_url: 'https://cdn.example.com/video.mp4' }] }));
    const response = await request(appWithFetch(fetchMock)).get(`/video/${generationUuid}`).set('x-api-key', env.MIDDLEWARE_API_KEY);
    expect(response.body).toEqual({ uuid: generationUuid, status: 'completed', progress: 100,
      videoUrl: 'https://cdn.example.com/video.mp4', provider: 'snapgen' });
  });

  it('normalizes a failed status and error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => success({ uuid: generationUuid, status: 3, status_percentage: 75,
      error_message: 'Generation rejected', generated_video: [] }));
    const response = await request(appWithFetch(fetchMock)).get(`/video/${generationUuid}`).set('x-api-key', env.MIDDLEWARE_API_KEY);
    expect(response.body).toEqual({ uuid: generationUuid, status: 'failed', progress: 100, videoUrl: null,
      provider: 'snapgen', error: 'Generation rejected' });
  });
});
