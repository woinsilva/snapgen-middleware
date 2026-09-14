import { Router } from 'express';
import { createVideoController } from '../controllers/video.controller.js';
import type { VideoProvider } from '../providers/video.provider.js';

export function createVideoRouter(service: VideoProvider): Router {
  const router = Router();
  const controller = createVideoController(service);
  router.post('/generate', controller.generate);
  router.post('/extend', controller.extend);
  router.post('/storyboard', controller.storyboard);
  router.get('/:uuid', controller.getByUuid);
  return router;
}
