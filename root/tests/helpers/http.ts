import nock from 'nock';
import express from 'express';
import { createStore, initSessionStore } from '../../src/core/session_store.js';
import { loadSessionConfig } from '../../src/config/session.js';

// Setup deterministic HTTP mocking for integration tests
export function setupHttpMocks() {
  // Allow only localhost by default in unit/integration
  if (!process.env.VERIFY_LLM) {
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1') || host.includes('localhost'));
  }
}

export function teardownHttpMocks() {
  nock.cleanAll();
  if (!process.env.VERIFY_LLM) {
    nock.enableNetConnect();
  }
}

// Create an express app instance with our routes (no listen)
export async function makeTestApp() {
  const app = express();
  app.use(express.json());
  // Ensure session store
  const cfg = loadSessionConfig();
  const store = createStore(cfg);
  initSessionStore(store);
  const { router } = await import('../../src/api/routes.js');
  app.use('/', router({
    // super lightweight logger interface for tests
    debug: () => void 0,
    info: () => void 0,
    warn: () => void 0,
    error: () => void 0,
  } as any));
  return app;
}
