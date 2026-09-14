import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { projectInput, tokenSecret } from './v3.helpers.js';

const env: AppEnv = {
  NODE_ENV: 'test', PORT: 3000, SNAPGEN_API_KEY: 'snapgen-secret', MIDDLEWARE_API_KEY: 'middleware-secret',
  SNAPGEN_TIMEOUT_MS: 1000, ALLOWED_ORIGINS: '*', SNAPGEN_BASE_URL: 'https://api.snapgen.ai',
  RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX: 100, LOG_LEVEL: 'silent', PROJECT_STATE_SECRET: tokenSecret,
};
const uuid = '550e8400-e29b-41d4-a716-446655440000';
const provider: VideoProvider = {
  generateVideo: vi.fn(async () => ({ uuid, status: 'processing', provider: 'snapgen', model: 'veo-3.1-fast' })),
  getVideo: vi.fn(async () => ({ uuid, status: 'processing', progress: 1, videoUrl: null, provider: 'snapgen' })),
  extendVideo: vi.fn(), createStoryboard: vi.fn(),
};

describe('V3 stateless project API', () => {
  it('preserves x-api-key authentication', async () => {
    expect((await request(createApp(env, provider)).post('/video/projects/start').send(projectInput())).status).toBe(401);
  });

  it('starts a valid project with 202 and no provider call', async () => {
    vi.mocked(provider.generateVideo).mockClear();
    const result = await request(createApp(env, provider)).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send(projectInput());
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ status: 'planning', progress: 0, model: 'veo-3.1-fast', targetDuration: 70 });
    expect(result.body.downloadUrl).toBeNull();
    expect(result.body.projectState).toMatch(/^pst1\./);
    expect(provider.generateVideo).not.toHaveBeenCalled();
  });

  it('rejects invalid model and invalid scene count', async () => {
    const app = createApp(env, provider);
    const invalidModel = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ ...projectInput(), model: 'grok-3' });
    expect(invalidModel.status).toBe(400);
    const invalidScenes = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ ...projectInput(), scenes: projectInput().scenes.slice(0, 8) });
    expect(invalidScenes.status).toBe(400);
  });

  it('continues from a valid token and rejects a tampered token', async () => {
    const app = createApp(env, provider);
    const started = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send(projectInput());
    const continued = await request(app).post('/video/projects/continue').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: started.body.projectState });
    expect(continued.status).toBe(200);
    expect(continued.body.status).toBe('generating');
    const tampered = `${started.body.projectState.slice(0, -1)}x`;
    const rejected = await request(app).post('/video/projects/continue').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: tampered });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('INVALID_PROJECT_STATE');
  });

  it('keeps V1/V2 available when PROJECT_STATE_SECRET is absent', async () => {
    const withoutSecret = { ...env };
    delete withoutSecret.PROJECT_STATE_SECRET;
    const app = createApp(withoutSecret, provider);
    expect((await request(app).get('/health')).status).toBe(200);
    const v3 = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send(projectInput());
    expect(v3.status).toBe(503);
    expect(v3.body.error).toBe('V3_NOT_CONFIGURED');
  });
});
