import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isPrivateAddress, SecureMediaDownloader } from '../src/media/secure-media-downloader.js';
import { FfmpegMediaProcessor } from '../src/media/ffmpeg-media-processor.js';
import { EphemeralOutputStore } from '../src/projects/project-output-store.js';
import { writeFile } from 'node:fs/promises';

describe('V3 secure media handling', () => {
  it.each(['127.0.0.1', '10.0.0.2', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1'])('rejects private address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it('accepts a public address and downloads bounded video bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'v3-download-test-'));
    const target = join(directory, 'clip.mp4');
    try {
      const downloader = new SecureMediaDownloader({
        maxBytes: 100,
        timeoutMs: 1_000,
        lookupImplementation: async () => [{ address: '8.8.8.8', family: 4 }],
        fetchImplementation: async () => new Response(new Uint8Array([0, 1, 2]), { headers: { 'content-type': 'video/mp4' } }),
      });
      expect(await downloader.download('https://cdn.example.com/clip.mp4', target)).toBe(3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects localhost before fetching', async () => {
    let fetched = false;
    const downloader = new SecureMediaDownloader({ maxBytes: 100, timeoutMs: 1_000, fetchImplementation: async () => { fetched = true; return new Response(); } });
    await expect(downloader.download('https://localhost/video.mp4', 'unused')).rejects.toThrow('Local media hosts');
    expect(fetched).toBe(false);
  });

  it('stores and resolves a signed-state-addressable ephemeral output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'v3-output-test-'));
    const source = join(directory, 'source.mp4');
    const outputDirectory = join(directory, 'outputs');
    try {
      await writeFile(source, new Uint8Array([1, 2, 3]));
      const store = new EphemeralOutputStore(outputDirectory, () => new Date('2026-09-14T12:00:00.000Z'));
      const output = await store.store(source, 60);
      expect(await store.resolve(output)).toBe(join(outputDirectory, `${output.handle}.mp4`));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
describe.skipIf(!ffmpegAvailable)('V3 FFmpeg pipeline', () => {
  it('normalizes, concatenates and trims local fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'v3-ffmpeg-test-'));
    try {
      const sources = [join(directory, 'one.mp4'), join(directory, 'two.mp4')];
      for (const [index, source] of sources.entries()) {
        const result = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${index ? 'blue' : 'red'}:s=320x180:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { windowsHide: true });
        expect(result.status).toBe(0);
      }
      const processor = new FfmpegMediaProcessor();
      const normalized = [join(directory, 'n1.mp4'), join(directory, 'n2.mp4')];
      await processor.normalize(sources[0]!, normalized[0]!, '720p', 1);
      await processor.normalize(sources[1]!, normalized[1]!, '720p', 1);
      const concat = join(directory, 'concat.mp4');
      await processor.concatenate(normalized, join(directory, 'concat.txt'), concat);
      const final = join(directory, 'final.mp4');
      await processor.finalize(concat, final, 2);
      const probe = await processor.probe(final);
      expect(Number(probe.format?.duration)).toBeCloseTo(2, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 120_000);
});
