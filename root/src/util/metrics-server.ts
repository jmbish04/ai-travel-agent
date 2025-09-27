import * as express from 'express';
import * as path from 'node:path';
import { createLogger } from './logging.js';
import { getPrometheusText, metricsMode, snapshot, snapshotV2, ingestEvent } from './metrics.js';

const log = createLogger();
const app = express.default();
const port = Number(process.env.METRICS_PORT || 3001);

app.use(express.json());

// Serve metrics dashboard
app.get('/', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public/metrics-dashboard.html'));
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  const mode = metricsMode();
  if (mode === 'prom') {
    const text = await getPrometheusText();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.status(200).send(text);
  }
  const legacy = String(req.query.mode || '').toLowerCase() === 'legacy';
  return res.json(legacy ? snapshot() : snapshotV2());
});

// Ingest endpoint for CLI metrics
app.post('/metrics/ingest', (req, res) => {
  try {
    const { name, labels, value } = req.body || {};
    if (!name) return res.status(400).json({ error: 'missing name' });
    ingestEvent(name, labels, value);
    try { log.info({ name, labels, value }, 'metrics_ingest_ok'); } catch {}
    return res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'metrics_ingest_failed');
    return res.status(500).json({ error: 'ingest_failed' });
  }
});

app.listen(port, () => {
  log.debug(`Metrics server running at http://localhost:${port}`);
});
