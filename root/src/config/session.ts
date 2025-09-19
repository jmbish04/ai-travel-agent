import { z } from 'zod';

const SessionConfigSchema = z.object({
  kind: z.enum(['memory', 'redis']).default('memory'),
  ttlSec: z.coerce.number().min(60).default(3600),
  redisUrl: z.string().optional(),
  timeoutMs: z.coerce.number().min(100).default(2000),
});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export function loadSessionConfig(): SessionConfig {
  const config = SessionConfigSchema.parse({
    kind: process.env.SESSION_STORE || 'memory',
    ttlSec: process.env.SESSION_TTL_SEC || 3600,
    redisUrl: process.env.SESSION_REDIS_URL,
    timeoutMs: process.env.SESSION_REDIS_TIMEOUT_MS || 2000,
  });

  if (config.kind === 'redis' && !config.redisUrl) {
    throw new Error('SESSION_REDIS_URL required when SESSION_STORE=redis');
  }

  return config;
}
