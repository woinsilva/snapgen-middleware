import { z } from 'zod';
import { calculateRawDuration, calculateSegmentCount, calculateTrimDuration, projectStatuses, sceneStatuses } from './project.domain.js';
import { projectModelProfileRegistry } from './project-model-profile.registry.js';

const text = (max: number) => z.string().trim().min(1).max(max);
export const visualBibleSchema = z.object({
  style: text(2_000),
  characters: z.array(z.object({ id: text(100).regex(/^[A-Za-z0-9_-]+$/), description: text(2_000) }).strict()).max(20),
  environment: text(3_000),
  continuityRules: z.array(text(1_000)).max(50),
}).strict();
export const projectSceneInputSchema = z.object({
  sequence: z.number().int().positive(), prompt: text(4_000), continuityInstructions: text(1_500).optional(),
}).strict();
const createBase = z.object({
  concept: text(4_000), model: text(100), duration: z.number().int().min(60).max(180), resolution: text(20), aspect_ratio: text(20),
  visualBible: visualBibleSchema, scenes: z.array(projectSceneInputSchema).min(1).max(30),
}).strict();
export const createProjectSchema = createBase.superRefine((value, context) => {
  let profile;
  try { profile = projectModelProfileRegistry.get(value.model); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: `Unsupported long-project model: ${value.model}` }); return; }
  if (!profile.allowedResolutions.includes(value.resolution)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['resolution'], message: `Model ${value.model} does not support resolution ${value.resolution}` });
  if (!profile.allowedAspectRatios.includes(value.aspect_ratio)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['aspect_ratio'], message: `Model ${value.model} does not support aspect ratio ${value.aspect_ratio}` });
  const expected = calculateSegmentCount(value.duration, profile.segmentDurationSeconds);
  if (value.scenes.length !== expected) context.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes'], message: `Expected exactly ${expected} scenes for ${value.duration} seconds` });
  value.scenes.forEach((scene, index) => { if (scene.sequence !== index + 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', index, 'sequence'], message: `Expected sequence ${index + 1} without gaps` }); });
});
export const projectStateSceneSchema = projectSceneInputSchema.extend({
  status: z.enum(sceneStatuses), attemptNumber: z.union([z.literal(0), z.literal(1)]), operation: z.literal('generate'),
  snapgenUuid: z.string().uuid().optional(), errorCode: text(200).optional(), errorMessage: text(1_000).optional(),
}).strict().superRefine((scene, context) => {
  if (['processing', 'completed'].includes(scene.status) && !scene.snapgenUuid) context.addIssue({ code: z.ZodIssueCode.custom, path: ['snapgenUuid'], message: `${scene.status} scene requires snapgenUuid` });
});
export const projectStateSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.string().uuid(), tokenVersion: z.number().int().positive(), model: text(100),
  targetDuration: z.number().int().min(60).max(180), segmentDuration: z.number().int().positive(), plannedSegmentCount: z.number().int().positive().max(30),
  rawDuration: z.number().int().positive(), trimDuration: z.number().int().nonnegative(), resolution: text(20), aspectRatio: text(20), concept: text(4_000),
  visualBible: visualBibleSchema, scenes: z.array(projectStateSceneSchema).min(1).max(30), paidOperations: z.number().int().nonnegative(),
  maxPaidOperations: z.number().int().positive(), maxAttemptsPerScene: z.literal(1), automaticPaidRetries: z.literal(0),
  status: z.enum(projectStatuses), progress: z.number().int().min(0).max(100), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  output: z.object({ handle: z.string().uuid(), expiresAt: z.string().datetime() }).strict().optional(), errorCode: text(200).optional(), errorMessage: text(1_000).optional(),
}).strict().superRefine((state, context) => {
  if (state.scenes.length !== state.plannedSegmentCount) context.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes'], message: 'Scene count does not match plannedSegmentCount' });
  if (state.paidOperations > state.maxPaidOperations) context.addIssue({ code: z.ZodIssueCode.custom, path: ['paidOperations'], message: 'Paid operations exceed project budget' });
  if (state.rawDuration !== state.plannedSegmentCount * state.segmentDuration) context.addIssue({ code: z.ZodIssueCode.custom, path: ['rawDuration'], message: 'Invalid raw duration' });
  if (state.trimDuration !== state.rawDuration - state.targetDuration) context.addIssue({ code: z.ZodIssueCode.custom, path: ['trimDuration'], message: 'Invalid trim duration' });
});
export const projectStateRequestSchema = z.object({ projectState: z.string().min(1) }).strict();
export const projectIdSchema = z.string().uuid();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type ValidatedProjectState = z.infer<typeof projectStateSchema>;
export function deriveProjectPlan(input: CreateProjectInput) {
  const segmentDuration = projectModelProfileRegistry.get(input.model).segmentDurationSeconds;
  const plannedSegmentCount = calculateSegmentCount(input.duration, segmentDuration);
  const rawDuration = calculateRawDuration(plannedSegmentCount, segmentDuration);
  return { segmentDuration, plannedSegmentCount, rawDuration, trimDuration: calculateTrimDuration(input.duration, rawDuration) };
}
