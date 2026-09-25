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
import { privacyRouter } from './routes/privacy.routes.js';
import { modelsRouter } from './routes/models.routes.js';
import { createVideoRouter } from './routes/video.routes.js';
import { SnapGenService } from './services/snapgen.service.js';
import type { VideoProvider } from './providers/video.provider.js';
import { createLogger } from './utils/logger.js';
import { createProjectFrameRouter, createProjectOutputRouter, createProjectRouter } from './projects/project.routes.js';
import { ProjectStateTokenService } from './projects/project-state-token.js';
import { StatelessProjectService } from './projects/project.service.js';
import { EphemeralOutputStore } from './projects/project-output-store.js';
import { SecureMediaDownloader } from './media/secure-media-downloader.js';
import { FfmpegMediaProcessor } from './media/ffmpeg-media-processor.js';
import { EphemeralProjectRenderer } from './projects/ephemeral-project-renderer.js';
import { RenderJobManager } from './projects/render-job.manager.js';
import { GenerationJobManager } from './projects/generation-job.manager.js';
import { EphemeralContinuityFrameStore } from './projects/project-continuity-frame-store.js';
import { LastFrameContinuityService } from './projects/last-frame-continuity.service.js';

function corsOrigins(value: string): true | string[] {
  if (value.trim() === '*') return true;
  return value.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export function createApp(
  env: AppEnv,
  service?: VideoProvider,
  suppliedProjectService?: StatelessProjectService,
  suppliedOutputStore?: EphemeralOutputStore,
): Express {
  const app = express();
  const origins = corsOrigins(env.ALLOWED_ORIGINS);
  const logger = createLogger(env.LOG_LEVEL);
  const provider = service ?? new SnapGenService(env, fetch, logger);
  const outputStore = suppliedOutputStore ?? new EphemeralOutputStore();
  const frameStore = new EphemeralContinuityFrameStore();
  const outputTtlSeconds = env.PROJECT_OUTPUT_TTL_SECONDS ?? 900;
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT}`;
  const projectService = suppliedProjectService ?? (env.PROJECT_STATE_SECRET ? (() => {
    const tokens = new ProjectStateTokenService(
      env.PROJECT_STATE_SECRET,
      env.PROJECT_STATE_SECRET_PREVIOUS,
      env.PROJECT_STATE_TOKEN_MAX_BYTES ?? 65_536,
    );
    const allowedHosts = env.SNAPGEN_MEDIA_ALLOWED_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean);
    const downloader = new SecureMediaDownloader({
      maxBytes: env.PROJECT_MEDIA_MAX_BYTES ?? 500_000_000,
      timeoutMs: env.PROJECT_MEDIA_TIMEOUT_MS ?? 120_000,
      maxRedirects: 2,
      allowedHosts,
    });
    const processor = new FfmpegMediaProcessor();
    const renderer = new EphemeralProjectRenderer(
      provider,
      downloader,
      processor,
      outputStore,
      outputTtlSeconds,
      logger,
    );
    const continuity = new LastFrameContinuityService(
      provider,
      downloader,
      processor,
      frameStore,
      tokens,
      publicBaseUrl,
      env.PROJECT_CONTINUITY_FRAME_TTL_SECONDS ?? 3_600,
    );
    return new StatelessProjectService(tokens, provider, renderer, env.PROJECT_STATE_TOKEN_TTL_SECONDS ?? 2_592_000, undefined, continuity);
  })() : undefined);
  const renderJobs = projectService
    ? new RenderJobManager(
      projectService,
      publicBaseUrl,
      env.PROJECT_RENDER_JOB_TTL_SECONDS ?? 3_600,
      env.PROJECT_RENDER_MAX_EXECUTION_SECONDS ?? 43_200,
      logger,
    )
    : undefined;
  const generationJobs = projectService
    ? new GenerationJobManager(projectService, { jobTtlSeconds: env.PROJECT_GENERATION_JOB_TTL_SECONDS ?? 14_400, logger })
    : undefined;
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
  app.use('/privacy', privacyRouter);
  app.use('/video/models', videoRateLimit, createAuthMiddleware(env.MIDDLEWARE_API_KEY), modelsRouter);
  app.use('/video/projects/output', videoRateLimit, createProjectOutputRouter(projectService, outputStore));
  app.use('/video/projects/frames', videoRateLimit, createProjectFrameRouter(projectService, frameStore));
  app.use('/video/projects', videoRateLimit, createAuthMiddleware(env.MIDDLEWARE_API_KEY), createProjectRouter(projectService, renderJobs, generationJobs));
  app.use('/video', videoRateLimit, createAuthMiddleware(env.MIDDLEWARE_API_KEY), createVideoRouter(provider));
  app.locals.jobLifecycle = {
    beginShutdown: () => ({ generation: generationJobs?.beginShutdown() ?? { active: 0, total: 0 }, render: renderJobs?.beginShutdown() ?? { active: 0, total: 0 } }),
    counts: () => ({ generation: generationJobs?.activeJobCount() ?? 0, render: renderJobs?.activeJobCount() ?? 0 }),
  };
  app.use(notFoundHandler);
  app.use(createErrorHandler(env));
  return app;
}
