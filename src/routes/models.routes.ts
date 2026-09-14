import { Router } from 'express';
import { videoModelRegistry } from '../models/video-model.registry.js';

export const modelsRouter = Router();
modelsRouter.get('/', (_request, response) => response.json({ models: videoModelRegistry.list() }));
