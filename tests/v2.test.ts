import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import { videoModelRegistry } from '../src/models/video-model.registry.js';
import { SnapGenService } from '../src/services/snapgen.service.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
const sourceUuid = '7d9f6f50-18a1-4ff0-bd1f-5a83639928ad';
const env: AppEnv = {
  NODE_ENV: 'test', PORT: 3000, SNAPGEN_API_KEY: 'snapgen-secret', MIDDLEWARE_API_KEY: 'middleware-secret',
  SNAPGEN_TIMEOUT_MS: 1000, ALLOWED_ORIGINS: '*', SNAPGEN_BASE_URL: 'https://api.snapgen.ai',
  RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX: 100, LOG_LEVEL: 'silent',
};

function appWithFetch(fetchMock: typeof fetch) {
  return createApp(env, new SnapGenService(env, fetchMock));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('V2 model registry and workflows', () => {
  it('lists safe documented capabilities behind authentication', async () => {
    const unauthorized = await request(createApp(env)).get('/video/models');
    expect(unauthorized.status).toBe(401);
    const result = await request(createApp(env)).get('/video/models').set('x-api-key', env.MIDDLEWARE_API_KEY);
    expect(result.status).toBe(200);
    expect(result.body.models.length).toBe(videoModelRegistry.list().length);
    expect(result.body.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'veo-3.1-fast', family: 'veo', supportsImageToVideo: true }),
      expect.objectContaining({ id: 'seedance-2', family: 'seedance', supportsExtend: true }),
      expect.objectContaining({ id: 'flux-3', family: 'flux', supportsExtend: false }),
    ]));
    expect(JSON.stringify(result.body)).not.toContain('/uapi/');
  });

  it('rejects an unsupported model before calling SnapGen', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).send({ prompt: 'A detailed cinematic scene', model: 'unknown-model' });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('UNSUPPORTED_MODEL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects model-specific unsupported parameters', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY)
      .send({ prompt: 'A detailed cinematic scene', model: 'veo-3.1-fast', aspect_ratio: '9:16' });
    expect(result.status).toBe(400);
    expect(result.body.code ?? result.body.error).toBe('VALIDATION_ERROR');
    expect(result.body.details[0].field).toBe('aspect_ratio');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adapts Grok image URLs to repeated file_urls fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.snapgen.ai/uapi/v1/video-gen/grok');
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('grok-3');
      expect(form.getAll('file_urls')).toEqual(['https://example.com/one.jpg', 'https://example.com/two.jpg']);
      expect(form.has('ref_images')).toBe(false);
      return response({ uuid, status: 1 });
    });
    const result = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).send({
        prompt: 'Use @image1 and @image2 in a cinematic scene', model: 'grok-3',
        ref_images: ['https://example.com/one.jpg', 'https://example.com/two.jpg'],
      });
    expect(result.status).toBe(200);
    expect(result.body.model).toBe('grok-3');
  });

  it('serializes Seedance image URLs as repeated ref_images', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.snapgen.ai/uapi/v1/video-gen/seedance');
      const form = init?.body as FormData;
      expect(form.getAll('ref_images')).toEqual(['https://example.com/frame.jpg']);
      expect(form.get('mode')).toBe('fast');
      return response({ uuid, status: 1 });
    });
    const result = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY)
      .send({ prompt: 'Animate this frame with a slow pan', model: 'seedance-2', ref_images: ['https://example.com/frame.jpg'] });
    expect(result.status).toBe(200);
  });

  it('extends a supported video without forwarding model-specific generation fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.snapgen.ai/uapi/v1/video-extend/veo');
      const form = init?.body as FormData;
      expect([...form.keys()]).toEqual(['prompt', 'ref_history']);
      expect(form.get('ref_history')).toBe(sourceUuid);
      return response({ uuid, status: 1 });
    });
    const result = await request(appWithFetch(fetchMock)).post('/video/extend')
      .set('x-api-key', env.MIDDLEWARE_API_KEY)
      .send({ prompt: 'Continue along the coastal road', model: 'veo-3.1-fast', source_uuid: sourceUuid });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ uuid, status: 'processing', provider: 'snapgen', operation: 'extend', model: 'veo-3.1-fast' });
  });

  it('rejects extend when the model has no documented support', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await request(appWithFetch(fetchMock)).post('/video/extend')
      .set('x-api-key', env.MIDDLEWARE_API_KEY)
      .send({ prompt: 'Continue the scene', model: 'flux-3', source_uuid: sourceUuid });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('UNSUPPORTED_OPERATION');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes a validated Grok storyboard as documented JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.snapgen.ai/uapi/v1/video-storyboard/grok');
      const form = init?.body as FormData;
      expect(JSON.parse(String(form.get('scenes')))).toEqual([
        { prompt: 'Sunrise over mountains', duration: 6, mode: 'custom' },
        { prompt: 'River flowing below', duration: 10, mode: 'custom' },
      ]);
      return response({ uuid, status: 1 });
    });
    const result = await request(appWithFetch(fetchMock)).post('/video/storyboard')
      .set('x-api-key', env.MIDDLEWARE_API_KEY)
      .send({ scenes: [{ prompt: 'Sunrise over mountains', duration: 6 }, { prompt: 'River flowing below', duration: 10 }] });
    expect(result.status).toBe(200);
    expect(result.body.operation).toBe('storyboard');
  });

  it('never retries a paid generation POST', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ detail: { error_code: 'SYSTEM_ERROR' } }, 503));
    const result = await request(appWithFetch(fetchMock)).post('/video/generate')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).send({ prompt: 'A detailed cinematic scene', model: 'veo-3.1-fast' });
    expect(result.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient status GET failures and parses provider status variants', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ detail: { error_code: 'SYSTEM_ERROR' } }, 503))
      .mockResolvedValueOnce(response({ uuid, status: 0, status_percentage: 0 }));
    const result = await request(appWithFetch(fetchMock)).get(`/video/${uuid}`).set('x-api-key', env.MIDDLEWARE_API_KEY);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('processing');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps documented Grok policy status -2 to failed', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ uuid, status: -2, error_message: 'Policy violation' }));
    const result = await request(appWithFetch(fetchMock)).get(`/video/${uuid}`).set('x-api-key', env.MIDDLEWARE_API_KEY);
    expect(result.body).toEqual({ uuid, status: 'failed', progress: 100, videoUrl: null, provider: 'snapgen', error: 'Policy violation' });
  });
});
