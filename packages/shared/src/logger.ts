import path from 'path';
import pino from 'pino';

let baseLogger: pino.Logger | null = null;

function getBaseLogger(): pino.Logger {
  if (baseLogger) return baseLogger;
  // Lazy init so LOG_LEVEL/LOG_FILE are read after apps have run dotenv.config()
  const isProd = process.env.NODE_ENV === 'production';
  const logPath = process.env.LOG_FILE || path.join(process.cwd(), 'fm-sync.log');
  const logLevel = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');
  const targets: pino.TransportTargetOptions[] = [
    !isProd
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', destination: 1 },
        }
      : { target: 'pino/file', options: { destination: 1 } },
    { target: 'pino/file', options: { destination: logPath, append: true, mkdir: true } },
  ];
  baseLogger = pino({ level: logLevel }, pino.transport({ targets }));
  return baseLogger;
}

export const baseLogger = new Proxy({} as pino.Logger, {
  get(_, prop) {
    return (getBaseLogger() as Record<string, unknown>)[prop as string];
  },
});

/**
 * Create a child logger with a service name and optional tag (e.g. 'bb' for Blackbaud, 'hs' for HubSpot).
 */
export function createLogger(name: string, tag?: string) {
  const bindings: Record<string, string> = { service: name };
  if (tag) bindings.tag = tag;
  return getBaseLogger().child(bindings);
}
