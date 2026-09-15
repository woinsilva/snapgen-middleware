import { Router } from 'express';
import { createProjectController } from './project.controller.js';
import type { EphemeralOutputStore } from './project-output-store.js';
import type { StatelessProjectService } from './project.service.js';
import type { RenderJobManager } from './render-job.manager.js';

export function createProjectRouter(service?: StatelessProjectService, renderJobs?: RenderJobManager): Router {
  const router = Router();
  const controller = createProjectController(service, undefined, renderJobs);
  router.post('/start', controller.start);
  router.post('/continue', controller.continue);
  router.post('/render', controller.render);
  router.get('/:projectId/render/:renderJobId', controller.renderStatus);
  return router;
}

export function createProjectOutputRouter(service?: StatelessProjectService, outputStore?: EphemeralOutputStore): Router {
  const router = Router();
  const controller = createProjectController(service, outputStore);
  router.get('/:projectId', controller.output);
  return router;
}
