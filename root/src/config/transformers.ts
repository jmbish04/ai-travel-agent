import 'dotenv/config';

/**
 * Feature flag for Transformers cascade.
 *
 * Controlled by `TRANSFORMERS_CASCADE_ENABLED` env variable.
 * Defaults to `false` when unset (LLM-first mode).
 */
export function transformersEnabled(): boolean {
  return process.env.TRANSFORMERS_CASCADE_ENABLED === 'true';
}
