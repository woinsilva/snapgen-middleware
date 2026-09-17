import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { StatelessProjectService, type ProjectRenderer, type RenderResult } from '../src/projects/project.service.js';
import { projectInput, testTokens, tokenSecret } from './v3.helpers.js';

const env: AppEnv = {
  NODE_ENV: 'test', PORT: 3000, SNAPGEN_API_KEY: 'snapgen-secret', MIDDLEWARE_API_KEY: 'middleware-secret',
  SNAPGEN_TIMEOUT_MS: 1000, ALLOWED_ORIGINS: '*', SNAPGEN_BASE_URL: 'https://api.snapgen.ai',
  RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX: 100, LOG_LEVEL: 'silent', PROJECT_STATE_SECRET: tokenSecret,
  PUBLIC_BASE_URL: 'https://video.example.test',
};
const uuid = '550e8400-e29b-41d4-a716-446655440000';
const output: RenderResult = { handle: '7d9f6f50-18a1-4ff0-bd1f-5a83639928ad', expiresAt: '2099-09-14T12:15:00.000Z' };
const provider = {
  generateVideo: vi.fn(), getVideo: vi.fn(), extendVideo: vi.fn(), createStoryboard: vi.fn(),
} as VideoProvider;

function readyService(renderer: ProjectRenderer): { service: StatelessProjectService; projectState: string; projectId: string } {
  const tokens = testTokens();
  const service = new StatelessProjectService(tokens, provider, renderer, 86_400, () => new Date('2026-09-14T12:00:00.000Z'));
  const state = service.verify(service.start(projectInput()).projectState);
  state.status = 'assembling';
  state.progress = 90;
  state.scenes.forEach((scene) => { scene.status = 'completed'; scene.attemptNumber = 1; scene.snapgenUuid = uuid; });
  return { service, projectState: tokens.sign(state), projectId: state.projectId };
}

async function waitForTerminal(app: ReturnType<typeof createApp>, projectId: string, renderJobId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await request(app).get(`/video/projects/${projectId}/render/${renderJobId}`).set('x-api-key', env.MIDDLEWARE_API_KEY);
    if (response.body.status !== 'processing') return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Render job did not reach a terminal state');
}

describe('V3 asynchronous render jobs', () => {
  it('returns 202 immediately and exposes processing through an authenticated JSON status endpoint', async () => {
    let resolveRender!: (value: RenderResult) => void;
    const renderer = { render: vi.fn(() => new Promise<RenderResult>((resolve) => { resolveRender = resolve; })) };
    const { service, projectState, projectId } = readyService(renderer);
    const app = createApp(env, provider, service);

    const started = await Promise.race([
      request(app).post('/video/projects/render').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Render request stayed open')), 1_000)),
    ]);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ projectId, status: 'processing', projectState: null, downloadUrl: null, error: null });
    expect(started.body.renderJobId).toMatch(/^[0-9a-f-]{36}$/i);

    const unauthorized = await request(app).get(`/video/projects/${projectId}/render/${started.body.renderJobId}`);
    expect(unauthorized.status).toBe(401);
    const processing = await request(app).get(`/video/projects/${projectId}/render/${started.body.renderJobId}`).set('x-api-key', env.MIDDLEWARE_API_KEY);
    expect(processing.body).toMatchObject({ status: 'processing', downloadUrl: null, projectState: null });
    resolveRender(output);
    const completed = await waitForTerminal(app, projectId, started.body.renderJobId);
    expect(completed.body.status).toBe('completed');
  });

  it('moves a successful render to completed and returns an absolute signed download URL', async () => {
    const renderer = { render: vi.fn(async () => output) };
    const { service, projectState, projectId } = readyService(renderer);
    const app = createApp(env, provider, service);
    const started = await request(app).post('/video/projects/render').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState });
    const completed = await waitForTerminal(app, projectId, started.body.renderJobId);
    expect(completed.body).toMatchObject({ projectId, renderJobId: started.body.renderJobId, status: 'completed', outputExpiresAt: output.expiresAt, error: null });
    expect(completed.body.projectState).toMatch(/^pst1\./);
    expect(completed.body.downloadUrl).toMatch(/^https:\/\/video\.example\.test\/video\/projects\/output\//);
    expect(completed.body.downloadUrl).toContain('?access=');
    expect(JSON.stringify(completed.body)).not.toContain(tokenSecret);
  });

  it('moves a failed render to failed without exposing internals or a download URL', async () => {
    const renderer = { render: vi.fn(async () => { throw new Error(`private ${tokenSecret}`); }) };
    const { service, projectState, projectId } = readyService(renderer);
    const app = createApp(env, provider, service);
    const started = await request(app).post('/video/projects/render').set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState });
    const failed = await waitForTerminal(app, projectId, started.body.renderJobId);
    expect(failed.body).toMatchObject({ status: 'failed', projectState: null, downloadUrl: null, outputExpiresAt: null, error: { code: 'PROJECT_RENDER_FAILED', message: 'Project rendering failed.' } });
    expect(JSON.stringify(failed.body)).not.toContain(tokenSecret);
  });

  it('rejects render start when the signed project is not ready', async () => {
    const renderer = { render: vi.fn(async () => output) };
    const tokens = testTokens();
    const service = new StatelessProjectService(tokens, provider, renderer);
    const projectState = service.start(projectInput()).projectState;
    const response = await request(createApp(env, provider, service)).post('/video/projects/render')
      .set('x-api-key', env.MIDDLEWARE_API_KEY).send({ projectState });
    expect(response.status).toBe(409);
    expect(renderer.render).not.toHaveBeenCalled();
  });
});
