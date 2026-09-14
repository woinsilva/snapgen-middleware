import { Router } from 'express';
import { createProjectController } from './project.controller.js';
import type { EphemeralOutputStore } from './project-output-store.js';
import type { StatelessProjectService } from './project.service.js';

export function createProjectRouter(service?: StatelessProjectService, outputStore?: EphemeralOutputStore): Router {
  const router = Router();
  const controller = createProjectController(service, outputStore);
  router.post('/start', controller.start);
  router.post('/continue', controller.continue);
  router.post('/render', controller.render);
  router.get('/output/:projectId', controller.output);
  return router;
}
