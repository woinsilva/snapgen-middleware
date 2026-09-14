import type { RequestHandler } from 'express';
import { storyboardSchema, uuidSchema, videoExtendSchema, videoGenerateSchema } from '../schemas/video.schema.js';
import type { VideoProvider } from '../providers/video.provider.js';

export function createVideoController(service: VideoProvider): {
  generate: RequestHandler;
  getByUuid: RequestHandler;
  extend: RequestHandler;
  storyboard: RequestHandler;
} {
  return {
    generate: async (request, response) => {
      const input = videoGenerateSchema.parse(request.body);
      const result = await service.generateVideo(input, response.locals.requestId);
      response.locals.requestUuid = result.uuid;
      response.json(result);
    },
    getByUuid: async (request, response) => {
      const uuid = uuidSchema.parse(request.params.uuid);
      response.locals.requestUuid = uuid;
      response.json(await service.getVideo(uuid, response.locals.requestId));
    },
    extend: async (request, response) => {
      const input = videoExtendSchema.parse(request.body);
      const result = await service.extendVideo(input, response.locals.requestId);
      response.locals.requestUuid = result.uuid;
      response.json(result);
    },
    storyboard: async (request, response) => {
      const input = storyboardSchema.parse(request.body);
      const result = await service.createStoryboard(input, response.locals.requestId);
      response.locals.requestUuid = result.uuid;
      response.json(result);
    },
  };
}
