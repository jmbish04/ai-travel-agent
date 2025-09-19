import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createLogger } from '../util/logging.js';
import { router } from './routes.js';
import { preloadPrompts } from '../core/prompts.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { RATE_LIMITER_CONFIG } from '../config/resilience.js';
import { loadSessionConfig } from '../config/session.js';
import { createStore, initSessionStore } from '../core/session_store.js';
import { ping } from '../core/stores/redis.js';

const log = createLogger();
const app = express();

// Initialize session store
const sessionConfig = loadSessionConfig();
const sessionStore = createStore(sessionConfig);
initSessionStore(sessionStore);

log.info({ sessionStore: sessionConfig.kind, ttlSec: sessionConfig.ttlSec }, 'Session store initialized');

// Rate limiter for API endpoints
const apiRateLimiter = new RateLimiter(RATE_LIMITER_CONFIG);

app.use(express.json({ limit: '512kb' }));

// Serve static files from public directory
app.use(express.static(path.join(process.cwd(), 'public')));

// CORS support for frontend integration
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Rate limiting middleware (skip for health checks and OPTIONS)
app.use(async (req, res, next) => {
  if (req.path === '/healthz' || req.method === 'OPTIONS') {
    return next();
  }
  
  if (!(await apiRateLimiter.acquire())) {
    log.warn({ method: req.method, path: req.path, ip: req.ip }, 'Rate limit exceeded');
    return res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.'
    });
  }
  
  // Auto-release after request completes
  resOnFinish(res, () => {
    apiRateLimiter.release();
  });
  
  next();
});

// Basic request logging
app.use((req, _res, next) => {
  const start = Date.now();
  (req as unknown as { log: ReturnType<typeof createLogger> }).log = log;
  log.debug({ method: req.method, path: req.path }, 'req:start');
  resOnFinish(_res, () => {
    const ms = Date.now() - start;
    log.debug({ method: req.method, path: req.path, ms }, 'req:done');
  });
  next();
});

function resOnFinish(res: express.Response, cb: () => void) {
  res.on('finish', cb);
  res.on('close', cb);
}

app.get('/healthz', async (_req, res) => {
  let storeHealth = 'ok';
  if (sessionConfig.kind === 'redis') {
    const isHealthy = await ping(sessionConfig);
    storeHealth = isHealthy ? 'ok' : 'degraded';
  }
  res.status(200).json({ ok: true, store: storeHealth });
});
app.use('/', router(log));

let serverStarted = false;

export function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  
  const port = Number(process.env.PORT ?? 3000);
  preloadPrompts()
    .catch(() => void 0)
    .finally(() => {
      app.listen(port, () => log.info({ port }, 'HTTP server started'));
    });
}

// Auto-start if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}


