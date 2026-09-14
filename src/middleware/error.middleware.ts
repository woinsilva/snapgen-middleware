import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError, SnapGenError } from '../errors.js';
import type { AppEnv } from '../config/env.js';

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({ error: 'Not found' });
};

function safeUpstreamDetails(details: unknown): unknown {
  if (typeof details === 'string') return { message: details.slice(0, 500) };
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const root = details as Record<string, unknown>;
  const nested = root.detail && typeof root.detail === 'object' && !Array.isArray(root.detail)
    ? root.detail as Record<string, unknown>
    : root;
  const allowed = ['error_code', 'error_message', 'message'];
  const result = Object.fromEntries(allowed.filter((key) => typeof nested[key] === 'string').map((key) => [key, nested[key]]));
  return Object.keys(result).length ? result : undefined;
}

export function createErrorHandler(env: AppEnv): ErrorRequestHandler {
  return (error: unknown, _request, response, _next) => {
    void _next;
    if (error instanceof ZodError) {
      response.status(400).json({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
      });
      return;
    }

    if (error instanceof ApiError) {
      response.status(error.status).json({ error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) });
      return;
    }

    if (error instanceof SnapGenError) {
      if (error.status === 504 && error.message === 'SnapGen request timeout') {
        response.status(504).json({ error: error.message });
        return;
      }
      const code = error.status === 429 ? 'RATE_LIMITED'
        : error.status === 401 || error.status === 403 ? 'AUTH_ERROR'
          : error.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR';
      const details = safeUpstreamDetails(error.details);
      response.status(error.status).json({
        error: error.message,
        code,
        message: 'The video provider request failed.',
        status: error.status,
        ...(details === undefined ? {} : { details }),
      });
      return;
    }

    const payload: Record<string, unknown> = { error: 'Internal server error' };
    if (env.NODE_ENV !== 'production' && error instanceof Error) payload.message = error.message;
    response.status(500).json(payload);
  };
}
