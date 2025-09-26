import { z } from 'zod';

const SessionConfigSchema = z.object({
  kind: z.enum(['memory', 'redis']).default('redis'),
  ttlSec: z.coerce.number().min(60).default(3600),
  redisUrl: z.string().optional(),
  timeoutMs: z.coerce.number().min(100).default(2000),
});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export function loadSessionConfig(): SessionConfig {
  const config = SessionConfigSchema.parse({
    kind: process.env.SESSION_STORE || 'redis',
    ttlSec: process.env.SESSION_TTL_SEC || 3600,
    redisUrl: process.env.SESSION_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    timeoutMs: process.env.SESSION_REDIS_TIMEOUT_MS || 2000,
  });

  // Fall back to memory if Redis URL is not available and not explicitly set
  if (config.kind === 'redis' && !config.redisUrl) {
    return { ...config, kind: 'memory' };
  }

  return config;
}
