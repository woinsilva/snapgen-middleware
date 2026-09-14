import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { ApiError } from '../errors.js';
import { projectStateSchema, type ValidatedProjectState } from './project.schemas.js';
import type { ProjectOutputState } from './project.domain.js';

const TOKEN_PREFIX = 'pst1';

function signature(secret: string, encodedPayload: string): Buffer {
  return createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${encodedPayload}`).digest();
}

function outputSignature(secret: string, encodedPayload: string): Buffer {
  return createHmac('sha256', secret).update(`pso1.${encodedPayload}`).digest();
}

export class ProjectStateTokenService {
  constructor(
    private readonly currentSecret: string,
    private readonly previousSecret?: string,
    private readonly maxTokenBytes = 65_536,
    private readonly now: () => Date = () => new Date(),
  ) {}

  sign(state: ValidatedProjectState, reserveBytes = 0): string {
    const validated = projectStateSchema.parse(state);
    const compressed = deflateRawSync(Buffer.from(JSON.stringify(validated)), { level: 9 });
    const payload = compressed.toString('base64url');
    const token = `${TOKEN_PREFIX}.${payload}.${signature(this.currentSecret, payload).toString('base64url')}`;
    if (Buffer.byteLength(token, 'utf8') > this.maxTokenBytes - reserveBytes) {
      throw new ApiError(413, 'PROJECT_STATE_TOO_LARGE', `Project State Token exceeds the safe ${this.maxTokenBytes}-byte envelope.`);
    }
    return token;
  }

  verify(token: string): ValidatedProjectState {
    if (Buffer.byteLength(token, 'utf8') > this.maxTokenBytes) throw new ApiError(413, 'PROJECT_STATE_TOO_LARGE', 'Project State Token is too large.');
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) return this.invalid();
    let supplied: Buffer;
    try { supplied = Buffer.from(parts[2], 'base64url'); } catch { return this.invalid(); }
    const valid = [this.currentSecret, this.previousSecret]
      .filter((secret): secret is string => Boolean(secret))
      .some((secret) => {
        const expected = signature(secret, parts[1]!);
        return supplied.length === expected.length && timingSafeEqual(supplied, expected);
      });
    if (!valid) return this.invalid();
    try {
      const json = inflateRawSync(Buffer.from(parts[1], 'base64url'), { maxOutputLength: 524_288 }).toString('utf8');
      const state = projectStateSchema.parse(JSON.parse(json) as unknown);
      if (new Date(state.expiresAt).getTime() <= this.now().getTime()) throw new ApiError(400, 'PROJECT_STATE_EXPIRED', 'Project State Token has expired.');
      return state;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return this.invalid();
    }
  }

  signOutputAccess(projectId: string, output: ProjectOutputState): string {
    const payload = Buffer.from(JSON.stringify({ projectId, handle: output.handle, expiresAt: output.expiresAt })).toString('base64url');
    return `pso1.${payload}.${outputSignature(this.currentSecret, payload).toString('base64url')}`;
  }

  verifyOutputAccess(token: string, expectedProjectId: string): ProjectOutputState {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'pso1' || !parts[1] || !parts[2]) return this.invalid();
    let supplied: Buffer;
    try { supplied = Buffer.from(parts[2], 'base64url'); } catch { return this.invalid(); }
    const valid = [this.currentSecret, this.previousSecret].filter((value): value is string => Boolean(value)).some((secret) => {
      const expected = outputSignature(secret, parts[1]!);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
    if (!valid) return this.invalid();
    try {
      const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      if (value.projectId !== expectedProjectId || typeof value.handle !== 'string' || typeof value.expiresAt !== 'string') return this.invalid();
      if (new Date(value.expiresAt).getTime() <= this.now().getTime()) throw new ApiError(410, 'PROJECT_OUTPUT_EXPIRED', 'The ephemeral project output has expired.');
      return { handle: value.handle, expiresAt: value.expiresAt };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return this.invalid();
    }
  }

  private invalid(): never {
    throw new ApiError(400, 'INVALID_PROJECT_STATE', 'Project State Token is invalid or has been modified.');
  }
}
