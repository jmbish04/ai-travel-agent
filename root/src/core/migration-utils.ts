export interface RetryOptions {
  retries?: number;
  backoffMs?: number;
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 2, backoffMs = 50 } = options;
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Operation failed after retries');
}

export function buildThreadKey(threadId: string, suffix: string): string {
  return `thread:${threadId}:${suffix}`;
}

export function sanitizeLimit(limit?: number, fallback = 50): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return fallback;
  }
  return Math.min(limit, 500);
}
