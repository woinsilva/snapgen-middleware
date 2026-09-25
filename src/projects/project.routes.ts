import { Router } from 'express';
import { createProjectController } from './project.controller.js';
import type { EphemeralOutputStore } from './project-output-store.js';
import type { StatelessProjectService } from './project.service.js';
import type { RenderJobManager } from './render-job.manager.js';
import type { GenerationJobManager } from './generation-job.manager.js';
import type { EphemeralContinuityFrameStore } from './project-continuity-frame-store.js';

export function createProjectRouter(service?: StatelessProjectService, renderJobs?: RenderJobManager, generationJobs?: GenerationJobManager): Router {
  const router = Router();
  const controller = createProjectController(service, undefined, renderJobs, generationJobs);
  router.post('/start', controller.start);
  router.post('/advance', controller.advance);
  router.post('/status', controller.status);
  router.post('/continue', controller.continue);
  router.post('/generation', controller.startGeneration);
  router.get('/:projectId/generation/:generationJobId', controller.generationStatus);
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

export function createProjectFrameRouter(service?: StatelessProjectService, frameStore?: EphemeralContinuityFrameStore): Router {
  const router = Router();
  const controller = createProjectController(service, undefined, undefined, undefined, frameStore);
  router.get('/:projectId', controller.frame);
  return router;
}
