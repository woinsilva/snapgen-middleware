import type { RequestHandler } from 'express';
import type { Logger } from '../utils/logger.js';

export function createRequestLogger(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const startedAt = performance.now();
    response.on('finish', () => {
      const record: Record<string, unknown> = {
        event: 'http_request',
        requestId: response.locals.requestId,
        method: request.method,
        path: request.originalUrl.split('?')[0],
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
      if (response.locals.requestUuid) record.generationUuid = response.locals.requestUuid;
      logger.info(record);
    });
    next();
  };
}
