import { 
  retry, 
  handleAll, 
  timeout, 
  ExponentialBackoff, 
  TimeoutStrategy,
  wrap,
  circuitBreaker,
  ConsecutiveBreaker
} from 'cockatiel';
import Bottleneck from 'bottleneck';
import { createLogger } from './logging.js';

const log = createLogger();

// Global configuration
const DEFAULT_CONFIG = {
  maxAttempts: 4,
  initialDelay: 200,
  maxDelay: 8000,
  timeoutMs: 10000,
  maxConcurrent: 3,
  minTime: 250,
  circuitBreakerThreshold: 5,
  circuitBreakerDuration: 30000
};

// Per-service configurations
const SERVICE_CONFIGS = {
  'amadeus': {
    maxAttempts: 3,
    timeoutMs: Number(process.env.AMADEUS_TIMEOUT_MS || 15000),
    maxConcurrent: 2,
    minTime: 500
  },
  'weather': {
    maxAttempts: 3,
    timeoutMs: 8000,
    maxConcurrent: 2,
    minTime: 250
  },
  'tavily': {
    maxAttempts: 3,
    timeoutMs: 12000,
    maxConcurrent: 1,
    minTime: 1000
  },
  'vectara': {
    maxAttempts: 3,
    timeoutMs: 10000,
    maxConcurrent: 2,
    minTime: 300
  },
  'opentripmap': {
    maxAttempts: 3,
    timeoutMs: 8000,
    maxConcurrent: 3,
    minTime: 200
  },
  'countries': {
    maxAttempts: 3,
    timeoutMs: 6000,
    maxConcurrent: 2,
    minTime: 200
  }
};

// Service instances
const limiters = new Map<string, Bottleneck>();
const policies = new Map<string, any>();

function getServiceConfig(service: string) {
  return { ...DEFAULT_CONFIG, ...SERVICE_CONFIGS[service as keyof typeof SERVICE_CONFIGS] };
}

function getLimiter(service: string): Bottleneck {
  if (!limiters.has(service)) {
    const config = getServiceConfig(service);
    const limiter = new Bottleneck({
      minTime: config.minTime,
      maxConcurrent: config.maxConcurrent,
    });
    limiters.set(service, limiter);
  }
  return limiters.get(service)!;
}

function getPolicy(service: string) {
  if (!policies.has(service)) {
    const config = getServiceConfig(service);
    
    const retryPolicy = retry(handleAll, {
      maxAttempts: config.maxAttempts,
      backoff: new ExponentialBackoff({
        initialDelay: config.initialDelay,
        maxDelay: config.maxDelay
      })
    });
    
    const timeoutPolicy = timeout(config.timeoutMs, TimeoutStrategy.Aggressive);
    
    const breakerPolicy = circuitBreaker(handleAll, {
      halfOpenAfter: config.circuitBreakerDuration,
      breaker: new ConsecutiveBreaker(config.circuitBreakerThreshold)
    });
    
    const policy = wrap(breakerPolicy, timeoutPolicy, retryPolicy);
    policies.set(service, policy);
  }
  return policies.get(service)!;
}

/**
 * Execute function with full resilience: retry, timeout, circuit breaker, rate limiting
 */
export async function withResilience<T>(
  service: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const limiter = getLimiter(service);
  const policy = getPolicy(service);

  const execute = async () => {
    try {
      return await fn();
    } catch (error) {
      try {
        const resp: any = (error as any)?.response;
        const details = resp ? {
          status: resp.status,
          body: (() => {
            try { return typeof resp.result !== 'undefined' ? resp.result : (typeof resp.body === 'string' ? resp.body.slice(0, 500) : resp.body); } catch { return undefined; }
          })()
        } : undefined;
        log.debug({ service, error: error instanceof Error ? error.message : String(error), ...details }, 'External call failed');
      } catch {
        log.debug({ service, error: error instanceof Error ? error.message : String(error) }, 'External call failed');
      }
      throw error;
    }
  };

  return limiter.schedule(() => policy.execute(execute));
}

/**
 * Legacy compatibility - wraps function with policies for Amadeus SDK
 */
export async function withPolicies<T>(
  fn: () => Promise<T>, 
  signal?: AbortSignal, 
  timeoutMs = Number(process.env.AMADEUS_TIMEOUT_MS || 15000)
): Promise<T> {
  return withResilience('amadeus', fn, signal);
}
