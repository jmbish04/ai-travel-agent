import nock from 'nock';
import { beforeEach, afterEach } from '@jest/globals';
import { createStore, initSessionStore } from '../../src/core/session_store.js';

// Configure nock allowlist in one place
nock.disableNetConnect();
nock.enableNetConnect((host) => {
  if (host.includes('127.0.0.1') || host.includes('localhost')) return true;
  if (host.includes('openrouter.ai')) return true;
  if (host.includes('api.open-meteo.com')) return true;
  if (host.includes('geocoding-api.open-meteo.com')) return true;
  if (host.includes('restcountries.com')) return true;
  if (host.includes('api.opentripmap.com')) return true;
  if (host.includes('api.search.brave.com')) return true;
  return false;
});

// Global test state reset helpers
let sessionStore: any = null;

export async function resetTestState() {
  // Reset session store if initialized
  if (sessionStore) {
    // Clear all test thread data
    const testThreadIds = ['test-thread', 'test-thread-2', 'test-thread-eviction', 'test-thread-redis-ttl', 'test-thread-bounded'];
    for (const threadId of testThreadIds) {
      try {
        await sessionStore.clear(threadId);
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
  }
  
  // Clear nock interceptors
  nock.cleanAll();
}

// Initialize session store for tests
beforeEach(async () => {
  // Disable transcript recording unless explicitly enabled
  if (!process.env.RECORD_TRANSCRIPTS) {
    process.env.RECORD_TRANSCRIPTS = 'false';
  }
  
  // Initialize session store
  sessionStore = createStore({
    kind: (process.env.SESSION_STORE as 'memory' | 'redis') || 'memory',
    ttlSec: 300, // Short TTL for tests
    redisUrl: process.env.SESSION_REDIS_URL
  });
  
  // Initialize global session store
  initSessionStore(sessionStore);
  
  await resetTestState();
});

afterEach(async () => {
  await resetTestState();
});
