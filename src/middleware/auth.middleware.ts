import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

function keysMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function createAuthMiddleware(apiKey: string): RequestHandler {
  return (request, response, next) => {
    if (!keysMatch(request.header('x-api-key'), apiKey)) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
