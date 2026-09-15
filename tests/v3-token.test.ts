import { describe, expect, it } from 'vitest';
import { projectInput, serviceWith, testTokens, tokenSecret } from './v3.helpers.js';
import type { VideoProvider } from '../src/providers/video.provider.js';
import { ProjectStateTokenService } from '../src/projects/project-state-token.js';
import { createHmac, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const unusedProvider = {} as VideoProvider;

function signRawState(state: Record<string, unknown>): string {
  const payload = deflateRawSync(Buffer.from(JSON.stringify(state))).toString('base64url');
  const signature = createHmac('sha256', tokenSecret).update(`pst1.${payload}`).digest('base64url');
  return `pst1.${payload}.${signature}`;
}

describe('V3 Project State Token', () => {
  it('round-trips a signed and compressed state', () => {
    const { service } = serviceWith(unusedProvider);
    const started = service.start(projectInput());
    const state = service.verify(started.projectState);
    expect(state.projectId).toBe(started.projectId);
    expect(state).toMatchObject({ schemaVersion: 2, generationStrategy: 'independent' });
    expect(started.projectState.startsWith('pst1.')).toBe(true);
  });

  it('rejects correctly signed states with a missing or unsupported generation strategy', () => {
    const { service } = serviceWith(unusedProvider);
    const state = service.verify(service.start(projectInput()).projectState) as unknown as Record<string, unknown>;
    const missing = { ...state };
    delete missing.generationStrategy;
    expect(() => testTokens().verify(signRawState(missing))).toThrow('invalid or has been modified');
    expect(() => testTokens().verify(signRawState({ ...state, generationStrategy: 'extend' }))).toThrow('invalid or has been modified');
  });

  it('detects generation strategy tampering through the HMAC signature', () => {
    const { service } = serviceWith(unusedProvider);
    const token = service.start(projectInput()).projectState;
    const parts = token.split('.');
    const state = JSON.parse(inflateRawSync(Buffer.from(parts[1]!, 'base64url')).toString('utf8')) as Record<string, unknown>;
    const tamperedPayload = deflateRawSync(Buffer.from(JSON.stringify({ ...state, generationStrategy: 'extend' }))).toString('base64url');
    expect(() => service.verify(`${parts[0]}.${tamperedPayload}.${parts[2]}`)).toThrow('invalid or has been modified');
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
    state.schemaVersion = 3;
    expect(() => testTokens().verify(signRawState(state))).toThrow('invalid or has been modified');
  });

  it.each([[70, 9], [180, 23]])('keeps a realistic %is project with %i scenes below the 64 KiB limit', (duration, scenes) => {
    const { service } = serviceWith(unusedProvider);
    const token = service.start(projectInput(duration)).projectState;
    expect(Buffer.byteLength(token)).toBeLessThan(65_536);
    expect(service.verify(token).scenes).toHaveLength(scenes);
  });

  it('rejects a token that exceeds its configured size limit', () => {
    const { service } = serviceWith(unusedProvider);
    const state = service.verify(service.start(projectInput(180)).projectState);
    state.scenes.forEach((scene) => { scene.prompt = randomBytes(2_500).toString('base64'); });
    expect(() => testTokens(new Date('2026-09-14T12:00:00.000Z'), 4_096).sign(state)).toThrow('exceeds');
  });
});
