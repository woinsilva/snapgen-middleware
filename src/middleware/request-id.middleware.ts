import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const MAX_REQUEST_ID_LENGTH = 128;

export const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const supplied = request.header('x-request-id')?.trim();
  const requestId = supplied && supplied.length <= MAX_REQUEST_ID_LENGTH ? supplied : randomUUID();
  response.locals.requestId = requestId;
  response.setHeader('x-request-id', requestId);
  next();
};
