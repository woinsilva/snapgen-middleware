import { z } from 'zod';

export const videoGenerateSchema = z.object({
    prompt: z.string().trim().min(1).max(10_000),
    model: z.string().trim().min(1),
    duration: z.number().int().positive().optional(),
    resolution: z.string().trim().min(1).optional(),
    aspect_ratio: z.string().trim().min(1).optional(),
    mode_image: z.enum(['frame', 'ingredient']).optional(),
    mode: z.string().trim().min(1).optional(),
    skip_audio: z.boolean().optional(),
    ref_images: z.array(z.string().url().refine((url) => /^https?:\/\//i.test(url), 'Must be an HTTP(S) URL')).default([]),
  })
  .strict();

export const videoExtendSchema = z.object({
  prompt: z.string().trim().min(1).max(10_000),
  model: z.string().trim().min(1),
  source_uuid: z.string().uuid(),
}).strict();

export const storyboardSchema = z.object({
  model: z.enum(['grok-video', 'grok-3']).default('grok-video'),
  scenes: z.array(z.object({
    prompt: z.string().trim().min(1).max(10_000),
    duration: z.union([z.literal(6), z.literal(10)]),
  }).strict()).min(2).max(10),
  aspect_ratio: z.enum(['landscape', 'portrait', 'square']).default('landscape'),
  resolution: z.enum(['480p', '720p']).default('480p'),
}).strict().superRefine((value, ctx) => {
  const total = value.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (total > 45) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes'], message: 'Total storyboard duration cannot exceed 45 seconds' });
});

export const uuidSchema = z.string().uuid();
export type VideoGenerateInput = z.infer<typeof videoGenerateSchema>;
export type VideoExtendInput = z.infer<typeof videoExtendSchema>;
export type StoryboardInput = z.infer<typeof storyboardSchema>;
