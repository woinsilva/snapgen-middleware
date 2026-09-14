import type { AppEnv } from '../config/env.js';

const priorities = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;

export interface Logger {
  info(record: Record<string, unknown>): void;
  error(record: Record<string, unknown>): void;
}

export function createLogger(level: AppEnv['LOG_LEVEL']): Logger {
  const write = (record: Record<string, unknown>) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...record }));
  return {
    info: (record) => {
      if (priorities[level] <= priorities.info) write(record);
    },
    error: (record) => {
      if (priorities[level] <= priorities.error) write(record);
    },
  };
}
