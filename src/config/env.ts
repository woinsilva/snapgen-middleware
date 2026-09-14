import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SNAPGEN_API_KEY: z.string().min(1, 'SNAPGEN_API_KEY is required'),
  MIDDLEWARE_API_KEY: z.string().min(1, 'MIDDLEWARE_API_KEY is required'),
  SNAPGEN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  ALLOWED_ORIGINS: z.string().default('*'),
  SNAPGEN_BASE_URL: z.string().url().default('https://api.snapgen.ai'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  PROJECT_STATE_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  PROJECT_STATE_SECRET_PREVIOUS: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  PROJECT_STATE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).max(31_536_000).optional(),
  PROJECT_STATE_TOKEN_MAX_BYTES: z.coerce.number().int().min(16_384).max(262_144).optional(),
  PROJECT_OUTPUT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).optional(),
  PROJECT_MEDIA_MAX_BYTES: z.coerce.number().int().min(1_000_000).max(2_000_000_000).optional(),
  PROJECT_MEDIA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).optional(),
  SNAPGEN_MEDIA_ALLOWED_HOSTS: z.string().optional(),
}).superRefine((value, context) => {
  if (value.PROJECT_STATE_SECRET && value.PROJECT_STATE_SECRET === value.MIDDLEWARE_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PROJECT_STATE_SECRET'],
      message: 'PROJECT_STATE_SECRET must not reuse MIDDLEWARE_API_KEY',
    });
  }
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return result.data;
}
