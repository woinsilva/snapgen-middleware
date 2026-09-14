import type { RequestHandler } from 'express';
import { ApiError } from '../errors.js';
import { createProjectSchema, projectIdSchema, projectStateRequestSchema } from './project.schemas.js';
import type { StatelessProjectService } from './project.service.js';
import type { EphemeralOutputStore } from './project-output-store.js';

export function createProjectController(service?: StatelessProjectService, outputStore?: EphemeralOutputStore): {
  start: RequestHandler; continue: RequestHandler; render: RequestHandler; output: RequestHandler;
} {
  const requiredService = () => {
    if (!service) throw new ApiError(503, 'V3_NOT_CONFIGURED', 'Stateless V3 requires PROJECT_STATE_SECRET.');
    return service;
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
      const result = await requiredService().continue(input.projectState, response.locals.requestId);
      response.locals.projectId = result.projectId;
      response.json(result);
    },
    render: async (request, response) => {
      const input = projectStateRequestSchema.parse(request.body);
      const result = await requiredService().render(input.projectState, response.locals.requestId);
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
        response.download(path, `${projectId}.mp4`, (error) => { if (error) next(error); });
      } catch (error) { next(error); }
    },
  };
}
