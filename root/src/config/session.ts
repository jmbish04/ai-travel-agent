import { z } from 'zod';

const SessionConfigSchema = z.object({
  kind: z.enum(['memory', 'cloudflare']).default('cloudflare'),
  ttlSec: z.coerce.number().min(60).default(3600),
  timeoutMs: z.coerce.number().min(100).default(2000),
  kvNamespace: z.string().default('SESSIONS'),
  cacheNamespace: z.string().optional(),
});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export function loadSessionConfig(): SessionConfig {
  const config = SessionConfigSchema.parse({
    kind: process.env.SESSION_STORE || 'cloudflare',
    ttlSec: process.env.SESSION_TTL_SEC || 3600,
    timeoutMs: process.env.SESSION_ADAPTER_TIMEOUT_MS || 2000,
    kvNamespace:
      process.env.SESSION_KV_NAMESPACE ||
      process.env.CLOUDFLARE_SESSIONS_NAMESPACE ||
      process.env.CLOUDFLARE_KV_NAMESPACE ||
      'SESSIONS',
    cacheNamespace:
      process.env.SESSION_CACHE_NAMESPACE ||
      process.env.CLOUDFLARE_CACHE_NAMESPACE ||
      process.env.CLOUDFLARE_KV_CACHE_NAMESPACE,
  });
  return config;
}
