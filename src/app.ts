import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { AppEnv } from './config/env.js';
import { createAuthMiddleware } from './middleware/auth.middleware.js';
import { createErrorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { createRequestLogger } from './middleware/logging.middleware.js';
import { requestIdMiddleware } from './middleware/request-id.middleware.js';
import { healthRouter } from './routes/health.routes.js';
import { createVideoRouter } from './routes/video.routes.js';
import { SnapGenService } from './services/snapgen.service.js';
import type { VideoProvider } from './providers/video.provider.js';
import { createLogger } from './utils/logger.js';

function corsOrigins(value: string): true | string[] {
  if (value.trim() === '*') return true;
  return value.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export function createApp(env: AppEnv, service?: VideoProvider): Express {
  const app = express();
  const origins = corsOrigins(env.ALLOWED_ORIGINS);
  const logger = createLogger(env.LOG_LEVEL);
  const provider = service ?? new SnapGenService(env, fetch, logger);
  const videoRateLimit = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_request, response) => response.status(429).json({ error: 'Too many requests' }),
  });

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(createRequestLogger(logger));
  app.use(helmet());
  app.use(cors({
    origin: origins === true ? true : (origin, callback) => callback(null, !origin || origins.includes(origin)),
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/health', healthRouter);
  app.use('/video', videoRateLimit, createAuthMiddleware(env.MIDDLEWARE_API_KEY), createVideoRouter(provider));
  app.use(notFoundHandler);
  app.use(createErrorHandler(env));
  return app;
}
