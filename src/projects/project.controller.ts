import type { RequestHandler } from 'express';
import { ApiError } from '../errors.js';
import { createProjectSchema, projectIdSchema, projectStateRequestSchema } from './project.schemas.js';
import type { StatelessProjectService } from './project.service.js';
import type { EphemeralOutputStore } from './project-output-store.js';
import type { RenderJobManager } from './render-job.manager.js';
import type { GenerationJobManager } from './generation-job.manager.js';

export function createProjectController(service?: StatelessProjectService, outputStore?: EphemeralOutputStore, renderJobs?: RenderJobManager, generationJobs?: GenerationJobManager): {
  start: RequestHandler; advance: RequestHandler; status: RequestHandler; continue: RequestHandler; startGeneration: RequestHandler; generationStatus: RequestHandler; render: RequestHandler; renderStatus: RequestHandler; output: RequestHandler;
} {
  const requiredService = () => {
    if (!service) throw new ApiError(503, 'V3_NOT_CONFIGURED', 'Stateless V3 requires PROJECT_STATE_SECRET.');
    return service;
  };
  const requiredRenderJobs = () => {
    if (!renderJobs) throw new ApiError(503, 'PROJECT_RENDERING_UNAVAILABLE', 'Asynchronous project rendering is not configured.');
    return renderJobs;
  };
  const requiredGenerationJobs = () => {
    if (!generationJobs) throw new ApiError(503, 'PROJECT_GENERATION_UNAVAILABLE', 'Asynchronous project generation is not configured.');
    return generationJobs;
  };
  return {
    start: async (request, response) => {
      const input = createProjectSchema.parse(request.body);
      const result = requiredService().start(input);
      response.locals.projectId = result.projectId;
      response.status(202).json(result);
    },
    continue: async (request, response) => {
      const input = projectStateRequestSchema.parse(request.body);
      requiredGenerationJobs().assertManualAdvanceAllowed(input.projectState);
      const result = await requiredService().continue(input.projectState, response.locals.requestId);
      response.locals.projectId = result.projectId;
      response.json(result);
    },
    advance: async (request, response) => {
      const input = projectStateRequestSchema.parse(request.body);
      requiredGenerationJobs().assertManualAdvanceAllowed(input.projectState);
      const result = await requiredService().advance(input.projectState, response.locals.requestId);
      response.locals.projectId = result.projectId;
      response.json(result);
    },
    status: async (request, response) => {
      const input = projectStateRequestSchema.parse(request.body);
      const result = await requiredService().status(input.projectState, response.locals.requestId);
      response.locals.projectId = result.projectId;
      response.json(result);
    },
    startGeneration: async (request, response) => {
      const input = projectStateRequestSchema.parse(request.body);
      const result = requiredGenerationJobs().start(input.projectState, response.locals.requestId);
      response.locals.projectId = result.projectId;
      response.status(202).json(result);
    },
    generationStatus: async (request, response) => {
      const projectId = projectIdSchema.parse(request.params.projectId);
      const generationJobId = projectIdSchema.parse(request.params.generationJobId);
      const result = requiredGenerationJobs().get(projectId, generationJobId);
      response.locals.projectId = result.projectId;
      response.json(result);
    },
    render: async (request, response) => {
      const input = projectStateRequestSchema.parse(request.body);
      const result = requiredRenderJobs().start(input.projectState, response.locals.requestId);
      response.locals.projectId = result.projectId;
      response.status(202).json(result);
    },
    renderStatus: async (request, response) => {
      const projectId = projectIdSchema.parse(request.params.projectId);
      const renderJobId = projectIdSchema.parse(request.params.renderJobId);
      const result = requiredRenderJobs().get(projectId, renderJobId);
      response.locals.projectId = result.projectId;
      response.json(result);
    },
    output: async (request, response, next) => {
      try {
        const projectId = projectIdSchema.parse(request.params.projectId);
        response.locals.projectId = projectId;
        const token = request.query.access;
        if (typeof token !== 'string') throw new ApiError(400, 'OUTPUT_ACCESS_REQUIRED', 'access query parameter is required.');
        const output = requiredService().authorizeOutput(projectId, token);
        if (!outputStore) throw new ApiError(503, 'PROJECT_OUTPUT_UNAVAILABLE', 'Ephemeral project output is unavailable.');
        const path = await outputStore.resolve(output);
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.download(path, `${projectId}.mp4`, (error) => { if (error) next(error); });
      } catch (error) { next(error); }
    },
  };
}
