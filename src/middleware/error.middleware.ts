import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { SnapGenError } from '../errors.js';
import type { AppEnv } from '../config/env.js';

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({ error: 'Not found' });
};

export function createErrorHandler(env: AppEnv): ErrorRequestHandler {
  return (error: unknown, _request, response, _next) => {
    void _next;
    if (error instanceof ZodError) {
      response.status(400).json({
        error: 'Validation error',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
      return;
    }

    if (error instanceof SnapGenError) {
      if (error.status === 504 && error.message === 'SnapGen request timeout') {
        response.status(504).json({ error: error.message });
        return;
      }
      response.status(error.status).json({ error: error.message, status: error.status, details: error.details });
      return;
    }

    const payload: Record<string, unknown> = { error: 'Internal server error' };
    if (env.NODE_ENV !== 'production' && error instanceof Error) payload.message = error.message;
    response.status(500).json(payload);
  };
}
