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
