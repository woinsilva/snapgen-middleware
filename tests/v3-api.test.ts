import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { projectInput, tokenSecret } from './v3.helpers.js';
import { loadEnv } from '../src/config/env.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EphemeralOutputStore } from '../src/projects/project-output-store.js';
import { StatelessProjectService } from '../src/projects/project.service.js';
import { testTokens } from './v3.helpers.js';

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
    const app = createApp(env, provider);
    expect((await request(app).post('/video/projects/start').send(projectInput())).status).toBe(401);
    expect((await request(app).post('/video/projects/advance').send({ projectState: 'pst1.test.test' })).status).toBe(401);
    expect((await request(app).post('/video/projects/status').send({ projectState: 'pst1.test.test' })).status).toBe(401);
  });

  it('starts a valid project with 202 and no provider call', async () => {
    vi.mocked(provider.generateVideo).mockClear();
    const result = await request(createApp(env, provider)).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send(projectInput());
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ status: 'planning', progress: 0, model: 'veo-3.1-fast', targetDuration: 70 });
    expect(result.body.downloadUrl).toBeNull();
    expect(result.body.projectState).toMatch(/^pst1\./);
    expect(new StatelessProjectService(testTokens(), provider).verify(result.body.projectState).generationStrategy).toBe('independent');
    expect(JSON.stringify(result.body)).not.toContain(tokenSecret);
    expect(provider.generateVideo).not.toHaveBeenCalled();
  });

  it('requires an independent, sufficiently strong project state secret', () => {
    const base = {
      SNAPGEN_API_KEY: 'snapgen-secret',
      MIDDLEWARE_API_KEY: 'shared-secret-that-is-at-least-32-characters',
    };
    expect(() => loadEnv({ ...base, PROJECT_STATE_SECRET: 'short' })).toThrow('PROJECT_STATE_SECRET');
    expect(() => loadEnv({ ...base, PROJECT_STATE_SECRET: base.MIDDLEWARE_API_KEY })).toThrow('must not reuse');
    expect(loadEnv({ ...base, PROJECT_STATE_SECRET: tokenSecret }).PROJECT_STATE_SECRET).toBe(tokenSecret);
  });

  it('rejects invalid model and invalid scene count', async () => {
    const app = createApp(env, provider);
    const invalidModel = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ ...projectInput(), model: 'grok-3' });
    expect(invalidModel.status).toBe(400);
    const invalidScenes = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ ...projectInput(), scenes: projectInput().scenes.slice(0, 8) });
    expect(invalidScenes.status).toBe(400);
  });

  it('separates paid advance from read-only status and rejects a tampered token', async () => {
    const app = createApp(env, provider);
    vi.mocked(provider.generateVideo).mockClear();
    vi.mocked(provider.getVideo).mockClear();
    const started = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send(projectInput());
    const idleStatus = await request(app).post('/video/projects/status').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: started.body.projectState });
    expect(idleStatus.status).toBe(200);
    expect(idleStatus.body.projectState).toBe(started.body.projectState);
    expect(provider.generateVideo).not.toHaveBeenCalled();
    expect(provider.getVideo).not.toHaveBeenCalled();

    const advanced = await request(app).post('/video/projects/advance').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: idleStatus.body.projectState });
    expect(advanced.status).toBe(200);
    expect(advanced.body.status).toBe('generating');
    expect(provider.generateVideo).toHaveBeenCalledTimes(1);

    const blockedAdvance = await request(app).post('/video/projects/advance').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: advanced.body.projectState });
    expect(blockedAdvance.status).toBe(409);
    expect(blockedAdvance.body.error).toBe('PROJECT_STATUS_REQUIRED');
    expect(provider.generateVideo).toHaveBeenCalledTimes(1);

    const polled = await request(app).post('/video/projects/status').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: advanced.body.projectState });
    expect(polled.status).toBe(200);
    expect(provider.getVideo).toHaveBeenCalledTimes(1);
    expect(provider.generateVideo).toHaveBeenCalledTimes(1);

    const tampered = `${started.body.projectState.slice(0, -1)}${started.body.projectState.endsWith('x') ? 'y' : 'x'}`;
    const rejected = await request(app).post('/video/projects/status').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: tampered });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('INVALID_PROJECT_STATE');
  });

  it('keeps the legacy continue endpoint authenticated and available', async () => {
    const app = createApp(env, provider);
    const started = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send(projectInput());
    expect((await request(app).post('/video/projects/continue').send({ projectState: started.body.projectState })).status).toBe(401);
    expect((await request(app).post('/video/projects/continue').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: started.body.projectState })).status).toBe(200);
  });

  it('keeps V1/V2 available when PROJECT_STATE_SECRET is absent', async () => {
    const withoutSecret = { ...env };
    delete withoutSecret.PROJECT_STATE_SECRET;
    const app = createApp(withoutSecret, provider);
    expect((await request(app).get('/health')).status).toBe(200);
    const v3 = await request(app).post('/video/projects/start').set('x-api-key', env.MIDDLEWARE_API_KEY).send(projectInput());
    expect(v3.status).toBe(503);
    expect(v3.body.error).toBe('V3_NOT_CONFIGURED');
    const unavailable = await request(app).post('/video/projects/status').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState: 'pst1.test.test' });
    expect(unavailable.status).toBe(503);
  });

  it('serves signed public output without x-api-key and rejects invalid access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'v3-output-api-test-'));
    try {
      const source = join(directory, 'source.mp4');
      await writeFile(source, new Uint8Array([0, 1, 2, 3]));
      const now = new Date('2026-09-14T12:00:00.000Z');
      const tokens = testTokens(now);
      const outputs = new EphemeralOutputStore(join(directory, 'outputs'), () => now);
      const service = new StatelessProjectService(tokens, provider, undefined, 86_400, () => now);
      const state = service.verify(service.start(projectInput()).projectState);
      state.status = 'completed';
      state.progress = 100;
      state.scenes.forEach((scene) => { scene.status = 'completed'; scene.attemptNumber = 1; scene.snapgenUuid = uuid; });
      state.output = await outputs.store(source, 60);
      const accessToken = tokens.signOutputAccess(state.projectId, state.output);
      const app = createApp(env, provider, service, outputs);
      const response = await request(app).get(`/video/projects/output/${state.projectId}`).query({ access: accessToken });
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('video/mp4');
      expect(response.headers['content-disposition']).toContain(`filename="${state.projectId}.mp4"`);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toHaveLength(4);

      const invalidProject = await request(app).get('/video/projects/output/not-a-uuid').query({ access: accessToken });
      expect(invalidProject.status).toBe(400);
      const wrongProject = await request(app).get('/video/projects/output/60c8481d-3089-402c-b948-3ca7c9843891').query({ access: accessToken });
      expect(wrongProject.status).toBe(400);
      const tampered = `${accessToken.slice(0, -1)}x`;
      const tamperedResponse = await request(app).get(`/video/projects/output/${state.projectId}`).query({ access: tampered });
      expect(tamperedResponse.status).toBe(400);
      const missing = { handle: '60c8481d-3089-402c-b948-3ca7c9843891', expiresAt: '2026-09-14T12:01:00.000Z' };
      const missingAccess = tokens.signOutputAccess(state.projectId, missing);
      const missingResponse = await request(app).get(`/video/projects/output/${state.projectId}`).query({ access: missingAccess });
      expect(missingResponse.status).toBe(410);
      expect(missingResponse.body.error).toBe('PROJECT_OUTPUT_UNAVAILABLE');

      const expiredTokens = testTokens(new Date('2026-09-14T12:02:00.000Z'));
      const expiredService = new StatelessProjectService(expiredTokens, provider);
      const expiredAccess = expiredTokens.signOutputAccess(state.projectId, missing);
      const expiredResponse = await request(createApp(env, provider, expiredService, outputs))
        .get(`/video/projects/output/${state.projectId}`).query({ access: expiredAccess });
      expect(expiredResponse.status).toBe(410);
      expect(expiredResponse.body.error).toBe('PROJECT_OUTPUT_EXPIRED');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
