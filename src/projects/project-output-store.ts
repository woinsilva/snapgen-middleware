import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError } from '../errors.js';
import type { ProjectOutputState } from './project.domain.js';

export class EphemeralOutputStore {
  constructor(private readonly directory = join(tmpdir(), 'snapgen-middleware-v3-outputs'), private readonly now: () => Date = () => new Date()) {}

  async store(source: string, ttlSeconds: number): Promise<ProjectOutputState> {
    await mkdir(this.directory, { recursive: true });
    const handle = randomUUID();
    const path = this.path(handle);
    await copyFile(source, path);
    const cleanup = setTimeout(() => { void rm(path, { force: true }); }, ttlSeconds * 1_000);
    cleanup.unref();
    return { handle, expiresAt: new Date(this.now().getTime() + ttlSeconds * 1_000).toISOString() };
  }

  async resolve(output: ProjectOutputState): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(output.handle)) throw new ApiError(403, 'INVALID_OUTPUT_ACCESS', 'Invalid output handle.');
    if (new Date(output.expiresAt).getTime() <= this.now().getTime()) {
      await rm(this.path(output.handle), { force: true });
      throw new ApiError(410, 'PROJECT_OUTPUT_EXPIRED', 'The ephemeral project output has expired.');
    }
    const path = this.path(output.handle);
    try { await access(path); } catch { throw new ApiError(410, 'PROJECT_OUTPUT_UNAVAILABLE', 'The ephemeral output was lost or cleaned up.'); }
    return path;
  }

  private path(handle: string): string { return join(this.directory, `${handle}.mp4`); }
}
