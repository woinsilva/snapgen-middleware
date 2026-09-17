import { randomUUID } from 'node:crypto';

function safeIdentifier(value: string | undefined, pattern: RegExp): string | undefined {
  return value && pattern.test(value) ? value : undefined;
}

export const processIdentity = Object.freeze({
  processInstanceId: randomUUID(),
  deployedCommit: safeIdentifier(process.env.RENDER_GIT_COMMIT, /^[0-9a-f]{7,64}$/i),
  renderServiceId: safeIdentifier(process.env.RENDER_SERVICE_ID, /^[A-Za-z0-9_-]{3,100}$/),
});
