import { z } from 'zod';

const modelSchema = z.enum(['veo-3.1', 'veo-3.1-fast', 'veo-2', 'veo-3.1-lite', 'omni-flash']);

export const videoGenerateSchema = z
  .object({
    prompt: z.string().trim().min(1).max(10_000),
    model: modelSchema,
    duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).default(8),
    resolution: z.enum(['720p', '1080p']).default('720p'),
    aspect_ratio: z.enum(['16:9', '9:16']).default('16:9'),
    mode_image: z.enum(['frame', 'ingredient']).optional(),
    ref_images: z.array(z.string().url().refine((url) => /^https?:\/\//i.test(url), 'Must be an HTTP(S) URL')).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const mode = value.mode_image ?? 'frame';
    const maximum = mode === 'ingredient' ? 3 : 2;
    if (value.ref_images.length > maximum) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum,
        inclusive: true,
        type: 'array',
        path: ['ref_images'],
        message: `${mode} mode accepts at most ${maximum} reference images`,
      });
    }

    if (value.model.startsWith('veo-3.1') && value.duration !== 8) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['duration'], message: 'Veo 3.1 models require duration 8' });
    }
    if (value.model.startsWith('veo-3.1') && value.aspect_ratio !== '16:9') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['aspect_ratio'], message: 'Veo 3.1 models require aspect_ratio 16:9' });
    }
    if (value.model === 'veo-2' && value.resolution !== '720p') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resolution'], message: 'Veo 2 supports only 720p' });
    }
    if (value.model !== 'omni-flash' && value.duration === 10) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['duration'], message: 'Duration 10 is supported only by omni-flash' });
    }
  });

export const uuidSchema = z.string().uuid();
export type VideoGenerateInput = z.infer<typeof videoGenerateSchema>;
