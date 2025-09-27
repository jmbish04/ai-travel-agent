import pino from 'pino';
import { scrubMessage, scrubPII } from './redact.js';

/**
 * Creates a pino logger with PII redaction unless LOG_LEVEL=debug.
 */
export function createLogger() {
  const level = process.env.LOG_LEVEL ?? 'info';
  const redactEnabled = level !== 'debug';
  const highlightMsg = level === 'debug';

  const decorate = (value: string): string => {
    if (!highlightMsg) return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    return `✦ ${trimmed} ✦`;
  };
  // Use pino hooks to scrub arguments before logging
  const log = pino({
    level,
    hooks: {
      logMethod(args: unknown[], method: (...a: unknown[]) => void) {
        try {
          const scrubbed = args.map((a) => {
            if (typeof a === 'string') {
              const clean = scrubMessage(a, redactEnabled);
              return decorate(clean);
            }
            const cleanObj = scrubPII(a, redactEnabled);
            if (highlightMsg && cleanObj && typeof cleanObj === 'object' && 'msg' in (cleanObj as Record<string, unknown>)) {
              const msgValue = (cleanObj as Record<string, unknown>).msg;
              if (typeof msgValue === 'string') {
                (cleanObj as Record<string, unknown>).msg = decorate(msgValue);
              }
            }
            return cleanObj;
          });
          method.apply(this, scrubbed as unknown[]);
        } catch {
          method.apply(this, args as unknown[]);
        }
      },
    },
  } as pino.LoggerOptions);
  return log;
}
