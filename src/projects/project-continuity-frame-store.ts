import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError } from '../errors.js';
import type { ProjectOutputState } from './project.domain.js';

export class EphemeralContinuityFrameStore {
  constructor(private readonly directory = join(tmpdir(), 'snapgen-middleware-v3-continuity-frames'), private readonly now: () => Date = () => new Date()) {}

  async store(source: string, ttlSeconds: number): Promise<ProjectOutputState> {
    await mkdir(this.directory, { recursive: true });
    const handle = randomUUID();
    const path = this.path(handle);
    await copyFile(source, path);
    const cleanup = setTimeout(() => { void rm(path, { force: true }); }, ttlSeconds * 1_000);
    cleanup.unref();
    return { handle, expiresAt: new Date(this.now().getTime() + ttlSeconds * 1_000).toISOString() };
  }

  async resolve(frame: ProjectOutputState): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(frame.handle)) throw new ApiError(403, 'INVALID_CONTINUITY_FRAME_ACCESS', 'Invalid continuity frame handle.');
    if (new Date(frame.expiresAt).getTime() <= this.now().getTime()) {
      await rm(this.path(frame.handle), { force: true });
      throw new ApiError(410, 'CONTINUITY_FRAME_EXPIRED', 'The continuity frame has expired.');
    }
    const path = this.path(frame.handle);
    try { await access(path); } catch { throw new ApiError(410, 'CONTINUITY_FRAME_UNAVAILABLE', 'The continuity frame was lost or cleaned up.'); }
    return path;
  }

  private path(handle: string): string { return join(this.directory, `${handle}.png`); }
}
