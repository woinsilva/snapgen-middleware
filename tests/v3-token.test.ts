import { describe, expect, it } from 'vitest';
import { projectInput, serviceWith, testTokens, tokenSecret } from './v3.helpers.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { ProjectStateTokenService } from '../src/projects/project-state-token.js';
import { createHmac, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const unusedProvider = {} as VideoProvider;

describe('V3 Project State Token', () => {
  it('round-trips a signed and compressed state', () => {
    const { service } = serviceWith(unusedProvider);
    const started = service.start(projectInput());
    expect(service.verify(started.projectState).projectId).toBe(started.projectId);
    expect(started.projectState.startsWith('pst1.')).toBe(true);
  });

  it('rejects payload modification and a wrong secret', () => {
    const { service } = serviceWith(unusedProvider);
    const token = service.start(projectInput()).projectState;
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
    expect(() => service.verify(tampered)).toThrow('invalid or has been modified');
    expect(() => new ProjectStateTokenService(`${tokenSecret}-wrong`).verify(token)).toThrow('invalid or has been modified');
  });

  it('rejects an expired token', () => {
    const startTime = new Date('2026-09-14T12:00:00.000Z');
    const { service } = serviceWith(unusedProvider, startTime);
    const token = service.start(projectInput()).projectState;
    const later = new ProjectStateTokenService(tokenSecret, undefined, 65_536, () => new Date('2026-09-16T12:00:00.000Z'));
    expect(() => later.verify(token)).toThrow('expired');
  });

  it('supports previous-secret verification for rotation', () => {
    const { service } = serviceWith(unusedProvider);
    const token = service.start(projectInput()).projectState;
    const rotated = new ProjectStateTokenService('new-test-secret-that-is-at-least-32-characters', tokenSecret);
    expect(rotated.verify(token).projectId).toBe(service.verify(token).projectId);
  });

  it('signs short-lived output access separately from the full state token', () => {
    const tokens = testTokens();
    const projectId = '550e8400-e29b-41d4-a716-446655440000';
    const output = { handle: '7d9f6f50-18a1-4ff0-bd1f-5a83639928ad', expiresAt: '2026-09-14T12:15:00.000Z' };
    const access = tokens.signOutputAccess(projectId, output);
    expect(tokens.verifyOutputAccess(access, projectId)).toEqual(output);
    expect(() => tokens.verifyOutputAccess(access, '60c8481d-3089-402c-b948-3ca7c9843891')).toThrow();
  });

  it('rejects a correctly signed payload with an unsupported schema version', () => {
    const { service } = serviceWith(unusedProvider);
    const state = service.verify(service.start(projectInput()).projectState) as unknown as Record<string, unknown>;
    state.schemaVersion = 2;
    const payload = deflateRawSync(Buffer.from(JSON.stringify(state))).toString('base64url');
    const signature = createHmac('sha256', tokenSecret).update(`pst1.${payload}`).digest('base64url');
    expect(() => testTokens().verify(`pst1.${payload}.${signature}`)).toThrow('invalid or has been modified');
  });

  it.each([70, 180])('keeps a realistic %is project below the 64 KiB limit', (duration) => {
    const { service } = serviceWith(unusedProvider);
    const token = service.start(projectInput(duration)).projectState;
    expect(Buffer.byteLength(token)).toBeLessThan(65_536);
    expect(service.verify(token).scenes).toHaveLength(Math.ceil(duration / 8));
  });

  it('rejects a token that exceeds its configured size limit', () => {
    const { service } = serviceWith(unusedProvider);
    const state = service.verify(service.start(projectInput(180)).projectState);
    state.scenes.forEach((scene) => { scene.prompt = randomBytes(2_500).toString('base64'); });
    expect(() => testTokens(new Date('2026-09-14T12:00:00.000Z'), 4_096).sign(state)).toThrow('exceeds');
  });
});
