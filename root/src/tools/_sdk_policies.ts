import Bottleneck from 'bottleneck';
import { withResilience } from '../util/resilience.js';

export const amadeusLimiter = new Bottleneck({
  minTime: Number(process.env.AMADEUS_MIN_MS ?? 100),
  maxConcurrent: Number(process.env.AMADEUS_MAX_CONC ?? 5),
});

/**
 * Wraps function with rate limiting, retries, and timeout policies.
 * @deprecated Use withResilience('amadeus', fn) instead
 */
export async function withPolicies<T>(
  fn: () => Promise<T>, 
  signal?: AbortSignal, 
  timeoutMs = 15000
): Promise<T> {
  return withResilience('amadeus', fn, signal);
}
