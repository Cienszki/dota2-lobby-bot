// bot-worker/src/logger.ts
// Simple structured logger for bot worker

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(msg: string, data?: unknown): void {
    if (shouldLog('debug')) {
      const extra = data instanceof Error ? data.message : data ? JSON.stringify(data) : '';
      console.log(`[${timestamp()}] [DEBUG] ${msg}`, extra);
    }
  },
  info(msg: string, data?: unknown): void {
    if (shouldLog('info')) {
      const extra = data instanceof Error ? data.message : data ? JSON.stringify(data) : '';
      console.log(`[${timestamp()}] [INFO] ${msg}`, extra);
    }
  },
  warn(msg: string, data?: unknown): void {
    if (shouldLog('warn')) {
      const extra = data instanceof Error ? data.message : data ? JSON.stringify(data) : '';
      console.warn(`[${timestamp()}] [WARN] ${msg}`, extra);
    }
  },
  error(msg: string, error?: unknown): void {
    if (shouldLog('error')) {
      const errMsg = error instanceof Error ? error.message : String(error ?? '');
      console.error(`[${timestamp()}] [ERROR] ${msg}`, errMsg);
    }
  },
};
