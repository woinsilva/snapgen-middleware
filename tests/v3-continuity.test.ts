import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { SecureMediaDownloader } from '../src/media/secure-media-downloader.js';
import type { FfmpegMediaProcessor } from '../src/media/ffmpeg-media-processor.js';
import { LastFrameContinuityService } from '../src/projects/last-frame-continuity.service.js';
import { EphemeralContinuityFrameStore } from '../src/projects/project-continuity-frame-store.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { projectInput, serviceWith, testTokens } from './v3.helpers.js';
import { StatelessProjectService } from '../src/projects/project.service.js';
import { createProjectFrameRouter } from '../src/projects/project.routes.js';

describe('V3 last-frame continuity', () => {
  it('turns the completed previous scene into one short-lived signed HTTPS reference', async () => {
    const previousUuid = '550e8400-e29b-41d4-a716-446655440000';
    const provider = {
      getVideoOnce: vi.fn(async () => ({ uuid: previousUuid, status: 'completed' as const, progress: 100, videoUrl: 'https://media.example/previous.mp4', provider: 'snapgen' as const })),
    } as unknown as VideoProvider;
    const downloader = { download: vi.fn(async () => 100) } as unknown as SecureMediaDownloader;
    const processor = { extractFinalFrame: vi.fn(async () => undefined) } as unknown as FfmpegMediaProcessor;
    const frame = { handle: '7d9f6f50-18a1-4ff0-bd1f-5a83639928ad', expiresAt: '2026-09-14T12:30:00.000Z' };
    const frames = { store: vi.fn(async () => frame) } as unknown as EphemeralContinuityFrameStore;
    const tokens = testTokens();
    const continuity = new LastFrameContinuityService(provider, downloader, processor, frames, tokens, 'https://middleware.example', 1_800);
    const { service } = serviceWith(provider);
    const state = service.verify(service.start(projectInput(60)).projectState);
    state.status = 'generating';
    state.scenes[0]!.status = 'completed';
    state.scenes[0]!.attemptNumber = 1;
    state.scenes[0]!.snapgenUuid = previousUuid;

    const references = await continuity.referenceImages(state, 2, 'request');

    expect(references).toHaveLength(1);
    const url = new URL(references[0]!);
    expect(url.origin).toBe('https://middleware.example');
    expect(url.pathname).toBe(`/video/projects/frames/${state.projectId}`);
    expect(tokens.verifyFrameAccess(url.searchParams.get('access')!, state.projectId)).toEqual(frame);
    expect(provider.getVideoOnce).toHaveBeenCalledWith(previousUuid, 'request:continuity-source');
    expect(downloader.download).toHaveBeenCalledWith('https://media.example/previous.mp4', expect.stringMatching(/source\.mp4$/));
    expect(processor.extractFinalFrame).toHaveBeenCalledWith(expect.stringMatching(/source\.mp4$/), expect.stringMatching(/final-frame\.png$/));
    expect(frames.store).toHaveBeenCalledWith(expect.stringMatching(/final-frame\.png$/), 1_800);
  });

  it('does not create a reference for the opening scene', async () => {
    const provider = { getVideoOnce: vi.fn() } as unknown as VideoProvider;
    const continuity = new LastFrameContinuityService(
      provider,
      { download: vi.fn() } as unknown as SecureMediaDownloader,
      { extractFinalFrame: vi.fn() } as unknown as FfmpegMediaProcessor,
      { store: vi.fn() } as unknown as EphemeralContinuityFrameStore,
      testTokens(),
      'https://middleware.example',
    );
    const { service } = serviceWith(provider);
    expect(await continuity.referenceImages(service.verify(service.start(projectInput(60)).projectState), 1, 'request')).toEqual([]);
    expect(provider.getVideoOnce).not.toHaveBeenCalled();
  });

  it('serves a frame only through its purpose-bound signed project URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'v3-frame-route-test-'));
    try {
      const source = join(directory, 'source.png');
      await writeFile(source, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      const now = new Date('2026-09-14T12:00:00.000Z');
      const tokens = testTokens(now);
      const store = new EphemeralContinuityFrameStore(join(directory, 'frames'), () => now);
      const frame = await store.store(source, 60);
      const projectId = '550e8400-e29b-41d4-a716-446655440000';
      const access = tokens.signFrameAccess(projectId, frame);
      const service = new StatelessProjectService(tokens, {} as VideoProvider);
      const app = express().use('/video/projects/frames', createProjectFrameRouter(service, store));

      const response = await request(app).get(`/video/projects/frames/${projectId}`).query({ access });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^image\/png/);
      expect(response.body).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
