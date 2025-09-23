/* eslint-disable @typescript-eslint/no-explicit-any */
import process from 'node:process';
import { getAllBreakerStats } from './circuit.js';
import { getAllLimiterStats } from './limiter.js';

/**
 * Minimal metrics utility with optional Prometheus exposure.
 * - Set METRICS=prom to enable Prometheus default registry at /metrics
 * - Set METRICS=json to enable lightweight JSON snapshot at /metrics
 */
// Lazy dynamic import to avoid hard dependency during tests/local runs
// Note: avoid type-level imports from 'prom-client' to keep dependency optional
let promClient: any | undefined;
let initPromise: Promise<void> | undefined;

const MODE = (process.env.METRICS ?? '').toLowerCase();
const IS_PROM = MODE === 'prom' || MODE === 'prometheus';
const IS_JSON = MODE === 'json';

export const metricsEnabled = IS_PROM || IS_JSON;

// JSON fallback counters
let messages = 0;
let answersWithCitations = 0;
let verifyPass = 0;
let verifyFail = 0;
let generatedAnswers = 0;
let answersUsingExternal = 0;

// Verify score distributions (simple buckets) and averages
type Dist = { buckets: Record<'0-0.4'|'0.4-0.7'|'0.7-1.0', number>; count: number; sum: number };
const mkDist = (): Dist => ({ buckets: { '0-0.4': 0, '0.4-0.7': 0, '0.7-1.0': 0 }, count: 0, sum: 0 });
const verifyScores = {
  relevance: mkDist(),
  grounding: mkDist(),
  coherence: mkDist(),
  context_consistency: mkDist(),
};

// Flow counters (low-cardinality labels only)
const chatTurns: Record<string, number> = {};
const routerLowConf: Record<string, number> = {};
const clarifyRequests: Record<string, number> = {};
const clarifyResolved: Record<string, number> = {};
const fallbacks: Record<string, number> = { web: 0, browser: 0 };
const verifyFailsByReason: Record<string, number> = {};

// Track clarification resolution latency per intent:slot
type LatAgg = { count: number; sum: number; min: number; max: number };
const clarifyResolutionLatency = new Map<string, LatAgg>();
const pendingClarify = new Map<string, number>(); // key = intent:slot → timestamp

// Router confidence distribution buckets
const routerConfidenceBuckets: Record<string, number> = {
  '0.0-0.5': 0,
  '0.5-0.6': 0,
  '0.6-0.75': 0,
  '0.75-0.9': 0,
  '0.9-1.0': 0,
};

// Business/session metrics (lightweight approximation for dev/demo)
const sessions = new Map<string, { startedAt: number; intent?: string; turns: number; resolved?: boolean }>();
let totalSessions = 0;
let resolvedSessions = 0;
const sessionOutcomes: Record<'auto'|'escalated'|'abandoned', number> = { auto: 0, escalated: 0, abandoned: 0 };
const ttrByIntent: Record<string, { count: number; sum: number; min: number; max: number }> = {};

// E2E latency histogram (ms)
const e2eBuckets = [300, 600, 1000, 2000, 3000, 5000, 8000];
const e2eHist = { buckets: Object.fromEntries(e2eBuckets.map(b => [String(b), 0])) as Record<string, number>, count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0 };

// Lightweight JSON aggregation for external requests (works even when METRICS=off)
type ExtAgg = {
  total: number;
  byStatus: Record<string, number>; // ok, 4xx, 5xx, timeout, network, unknown
  byContext: Record<string, number>; // query_type, location, domain context
  latency: { count: number; sum: number; min: number; max: number };
};
const externalAgg = new Map<string, ExtAgg>(); // key = target
let toolCallsTotal = 0;

// Quality correlation tracking - connects confidence with outcomes
const confidenceOutcomes = new Map<string, {
  high_conf_success: number,
  high_conf_fail: number, 
  low_conf_success: number,
  low_conf_fail: number
}>();

// Router anomaly tracking per intent
const routerAnomalies = new Map<string, { high_conf_miss: number; low_conf_hit: number }>();

// Stage-level metrics (legacy, string key "stage_intent")
const stageMetrics = {
  success: new Map<string, number>(),
  failure: new Map<string, number>(),
  latency: new Map<string, { count: number; sum: number; min: number; max: number }>(),
  verify_success: new Map<string, number>(),
  verify_failure: new Map<string, number>()
};

// Stage-level metrics (v2) with separate stage and intent
type StageName = 'guard'|'extract'|'route'|'gather'|'blend'|'verify';
type Outcome = 'success'|'clarify'|'fail'|'escalated';
type LatencyAgg = { count: number; sum: number; min: number; max: number; samples: number[] };
type StageIntentStats = { outcomes: Record<Outcome, number>; latency: LatencyAgg };
const pipelineStats = new Map<StageName, Map<string, StageIntentStats>>();
const LAT_SAMPLES_MAX = 500;
function getStageIntentStats(stage: StageName, intent: string): StageIntentStats {
  const byIntent = pipelineStats.get(stage) ?? new Map<string, StageIntentStats>();
  if (!pipelineStats.has(stage)) pipelineStats.set(stage, byIntent);
  const key = intent || 'unknown';
  const cur = byIntent.get(key) ?? {
    outcomes: { success: 0, clarify: 0, fail: 0, escalated: 0 },
    latency: { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0, samples: [] },
  };
  if (!byIntent.has(key)) byIntent.set(key, cur);
  return cur;
}
function addLatency(lat: LatAgg | LatencyAgg, v: number) {
  lat.count += 1;
  lat.sum += v;
  lat.min = Math.min(lat.min, v);
  lat.max = Math.max(lat.max, v);
  const arr = (lat as any).samples as number[] | undefined;
  if (arr) {
    arr.push(v);
    if (arr.length > LAT_SAMPLES_MAX) arr.shift();
  }
}
function percentile(arr: number[], p: number): number {
  if (!arr || arr.length === 0) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * (a.length - 1))));
  return a[idx] ?? 0;
}

// Search quality tracking
const searchQuality = new Map<string, {
  total: number;
  complexQueries: number;
  avgComplexityConfidence: { sum: number; count: number };
  resultCounts: { sum: number; count: number };
}>();
// Track upgrade requests separately to avoid double-counting in search totals
let searchUpgradeRequests = 0;

type Labels = { target?: string; status?: string; query_type?: string; location?: string; domain?: string; confidence?: string };

// Prometheus metrics (conditionally initialized)
type CounterT = { inc: (labels?: Record<string, string>) => void };
type HistogramT = { observe: (labels: Record<string, string>, v: number) => void };
type GaugeT = { set: (labels: Record<string, string>, v: number) => void };
type RegistryT = { metrics: () => string };
let register: RegistryT | undefined;
let counterMessages: CounterT | undefined;
let counterExtReq: CounterT | undefined;
let histExtLatency: HistogramT | undefined;
let gaugeBreakerState: GaugeT | undefined;
let counterBreakerEvents: CounterT | undefined;
let counterRateLimitThrottled: CounterT | undefined;
let counterChatTurn: CounterT | undefined;
let counterRouterLowConf: CounterT | undefined;
let counterClarify: CounterT | undefined;
let counterClarifyResolved: CounterT | undefined;
let counterFallback: CounterT | undefined;
let counterAnswersWithCitations: CounterT | undefined;
let counterVerifyFail: CounterT | undefined;
let histE2ESeconds: HistogramT | undefined;
let counterSessionResolved: CounterT | undefined;

async function ensureProm(): Promise<void> {
  if (!IS_PROM) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const modName = 'prom-client';
    promClient = (await import(modName)) as any;
    const {
      Registry,
      collectDefaultMetrics,
      Counter,
      Histogram,
      Gauge,
    } = promClient as any;
    register = new Registry() as RegistryT;
    collectDefaultMetrics({ register });
    counterMessages = new Counter({
      name: 'messages_total',
      help: 'Total chat messages processed',
      registers: [register],
    }) as CounterT;
    counterExtReq = new Counter({
      name: 'external_requests_total',
      help: 'External adapter requests',
      labelNames: ['target', 'status'],
      registers: [register],
    }) as CounterT;
    histExtLatency = new Histogram({
      name: 'external_request_latency_ms',
      help: 'Latency of external adapter requests in milliseconds',
      labelNames: ['target', 'status'],
      buckets: [50, 100, 200, 400, 800, 2000, 4000],
      registers: [register],
    }) as HistogramT;
    gaugeBreakerState = new Gauge({
      name: 'circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 0.5=halfOpen, 1=open)',
      labelNames: ['target'],
      registers: [register],
    }) as GaugeT;
    counterBreakerEvents = new Counter({
      name: 'circuit_breaker_events_total',
      help: 'Circuit breaker events',
      labelNames: ['target', 'type'],
      registers: [register],
    }) as CounterT;
    counterRateLimitThrottled = new Counter({
      name: 'rate_limit_throttled_total',
      help: 'Rate limit throttled requests',
      labelNames: ['target'],
      registers: [register],
    }) as CounterT;

    // Conversation/flow metrics
    counterChatTurn = new Counter({
      name: 'chat_turn_total',
      help: 'Chat turns by intent',
      labelNames: ['intent'],
      registers: [register],
    }) as CounterT;
    counterRouterLowConf = new Counter({
      name: 'router_low_conf_total',
      help: 'Router low confidence routes',
      labelNames: ['intent'],
      registers: [register],
    }) as CounterT;
    counterClarify = new Counter({
      name: 'clarify_total',
      help: 'Clarifications requested',
      labelNames: ['intent', 'slot'],
      registers: [register],
    }) as CounterT;
    counterClarifyResolved = new Counter({
      name: 'clarify_resolved_total',
      help: 'Clarifications resolved',
      labelNames: ['intent'],
      registers: [register],
    }) as CounterT;
    counterFallback = new Counter({
      name: 'fallback_total',
      help: 'Fallback usage count',
      labelNames: ['kind'],
      registers: [register],
    }) as CounterT;
    counterAnswersWithCitations = new Counter({
      name: 'answers_with_citations_total',
      help: 'Answers emitted with citations',
      registers: [register],
    }) as CounterT;
    counterVerifyFail = new Counter({
      name: 'verify_fail_total',
      help: 'Verification failures by reason',
      labelNames: ['reason'],
      registers: [register],
    }) as CounterT;
    histE2ESeconds = new Histogram({
      name: 'e2e_latency_seconds',
      help: 'End-to-end chat latency in seconds',
      buckets: [0.3, 0.6, 1, 2, 3, 5, 8],
      registers: [register],
    }) as HistogramT;
    counterSessionResolved = new Counter({
      name: 'session_resolved_total',
      help: 'Sessions resolved by mode',
      labelNames: ['mode'],
      registers: [register],
    }) as CounterT;
  })();
  return initPromise;
}

// Kick off initialization without blocking; ignore failure if prom-client is not installed
// no-await-in-loop intentionally avoided here
void ensureProm().catch(() => undefined);

export function incMessages() {
  messages += 1;
  if (counterMessages) counterMessages.inc();
}

// Optional remote push target to aggregate metrics across processes (e.g., CLI -> server)
const PUSH_URL = process.env.METRICS_PUSH_URL;
async function pushIngest(name: string, labels?: Record<string, string>, value?: number) {
  if (!PUSH_URL) return;
  try {
    await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, labels, value }),
    });
  } catch {
    // ignore push errors in dev
  }
}

function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

export function incTurn(intent: string) {
  bump(chatTurns, intent || 'unknown');
  if (counterChatTurn) counterChatTurn.inc({ intent: intent || 'unknown' });
  void pushIngest('chat_turn_total', { intent: intent || 'unknown' });
}

export function incRouterLowConf(intent: string) {
  bump(routerLowConf, intent || 'unknown');
  if (counterRouterLowConf) counterRouterLowConf.inc({ intent: intent || 'unknown' });
  void pushIngest('router_low_conf_total', { intent: intent || 'unknown' });
}

export function incClarify(intent: string, slot: string) {
  const key = `${intent || 'unknown'}:${slot || 'unknown'}`;
  bump(clarifyRequests, key);
  // Record pending start timestamp for resolution latency
  pendingClarify.set(key, Date.now());
  if (counterClarify) counterClarify.inc({ intent: intent || 'unknown', slot: slot || 'unknown' });
  void pushIngest('clarify_total', { intent: intent || 'unknown', slot: slot || 'unknown' });
}

export function incClarifyResolved(intent: string, slot?: string) {
  bump(clarifyResolved, intent || 'unknown');
  // Compute resolution latency if we know the slot
  if (slot) {
    const key = `${intent || 'unknown'}:${slot || 'unknown'}`;
    const t0 = pendingClarify.get(key);
    if (t0) {
      const d = Date.now() - t0;
      pendingClarify.delete(key);
      const agg = clarifyResolutionLatency.get(key) ?? { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0 };
      addLatency(agg, d);
      clarifyResolutionLatency.set(key, agg);
    }
  }
  if (counterClarifyResolved) counterClarifyResolved.inc({ intent: intent || 'unknown' });
  void pushIngest('clarify_resolved_total', { intent: intent || 'unknown' });
}

export function incFallback(kind: 'web' | 'browser') {
  bump(fallbacks, kind);
  if (counterFallback) counterFallback.inc({ kind });
  void pushIngest('fallback_total', { kind });
}

export function incAnswersWithCitations() {
  answersWithCitations += 1;
  if (counterAnswersWithCitations) counterAnswersWithCitations.inc();
  void pushIngest('answers_with_citations_total');
}

export function incGeneratedAnswer() {
  generatedAnswers += 1;
}

export function incAnswerUsingExternal() {
  answersUsingExternal += 1;
}

export function incVerifyPass() {
  verifyPass += 1;
}

export function incVerifyFail(reason: string) {
  verifyFail += 1;
  const r = (reason || 'unknown').toLowerCase();
  verifyFailsByReason[r] = (verifyFailsByReason[r] ?? 0) + 1;
  if (counterVerifyFail) counterVerifyFail.inc({ reason: r });
  void pushIngest('verify_fail_total', { reason: r });
}

export function observeVerifyScores(scores: { relevance: number; grounding: number; coherence: number; context_consistency: number }) {
  const clamp = (v: number) => Math.max(0, Math.min(1, isFinite(v) ? v : 0));
  const bucket = (v: number): keyof Dist['buckets'] => (v < 0.4 ? '0-0.4' : v < 0.7 ? '0.4-0.7' : '0.7-1.0');
  const upd = (dist: Dist, v: number) => { const b = bucket(v); dist.buckets[b] += 1; dist.count += 1; dist.sum += v; };
  upd(verifyScores.relevance, clamp(scores.relevance));
  upd(verifyScores.grounding, clamp(scores.grounding));
  upd(verifyScores.coherence, clamp(scores.coherence));
  upd(verifyScores.context_consistency, clamp(scores.context_consistency));
}

export function observeE2E(durationMs: number) {
  e2eHist.count += 1;
  e2eHist.sum += durationMs;
  e2eHist.min = Math.min(e2eHist.min, durationMs);
  e2eHist.max = Math.max(e2eHist.max, durationMs);
  for (const b of e2eBuckets) {
    if (durationMs <= b) {
      const key = String(b);
      e2eHist.buckets[key] = (e2eHist.buckets[key] ?? 0) + 1;
      break;
    }
  }
  histE2ESeconds?.observe({}, durationMs / 1000);
  void pushIngest('e2e_latency_ms', {}, durationMs);
}

// Session helpers (best-effort, dev-only)
export function startSession(threadId: string, intent?: string) {
  if (!threadId) return;
  if (!sessions.has(threadId)) {
    sessions.set(threadId, { startedAt: Date.now(), intent, turns: 0, resolved: false });
    totalSessions += 1;
  }
}

export function noteTurn(threadId: string, intent?: string) {
  if (!threadId) return;
  const s = sessions.get(threadId) ?? { startedAt: Date.now(), turns: 0 } as any;
  s.turns = (s.turns ?? 0) + 1;
  if (!s.intent && intent) s.intent = intent;
  sessions.set(threadId, s);
}

export function resolveSession(threadId: string, mode: 'auto' | 'escalated' | 'abandoned' = 'auto') {
  if (!threadId) return;
  const s = sessions.get(threadId);
  if (!s || s.resolved) return;
  s.resolved = true;
  sessions.set(threadId, s);
  resolvedSessions += 1;
  sessionOutcomes[mode] = (sessionOutcomes[mode] ?? 0) + 1;
  const intent = s.intent || 'unknown';
  const dur = Date.now() - s.startedAt;
  const agg = (ttrByIntent[intent] ?? { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0 });
  agg.count += 1;
  agg.sum += dur;
  agg.min = Math.min(agg.min, dur);
  agg.max = Math.max(agg.max, dur);
  ttrByIntent[intent] = agg;
  if (counterSessionResolved) counterSessionResolved.inc({ mode });
}

export function observeExternal(labels: Labels, durationMs: number) {
  if (counterExtReq)
    counterExtReq.inc({
      target: labels.target ?? 'unknown',
      status: labels.status ?? 'unknown',
    });
  if (histExtLatency)
    histExtLatency.observe(
      { target: labels.target ?? 'unknown', status: labels.status ?? 'unknown' },
      durationMs,
    );

  // Always update JSON aggregation (even when not in JSON mode), so /metrics can still respond
  const target = labels.target ?? 'unknown';
  const status = labels.status ?? 'unknown';
  const prev = externalAgg.get(target) ?? {
    total: 0,
    byStatus: {},
    byContext: {},
    latency: { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0 },
  };
  prev.total += 1;
  prev.byStatus[status] = (prev.byStatus[status] ?? 0) + 1;
  
  // Track bounded context labels to avoid high cardinality
  if (labels.query_type) {
    const key = `query_type:${labels.query_type}`;
    prev.byContext[key] = (prev.byContext[key] ?? 0) + 1;
  }
  if (labels.location) {
    // Bound location to first 20 chars to avoid high cardinality
    const boundedLocation = labels.location.toLowerCase().slice(0, 20);
    const key = `location:${boundedLocation}`;
    prev.byContext[key] = (prev.byContext[key] ?? 0) + 1;
  }
  if (labels.domain) {
    const key = `domain:${labels.domain}`;
    prev.byContext[key] = (prev.byContext[key] ?? 0) + 1;
  }
  if (labels.confidence) {
    const key = `confidence:${labels.confidence}`;
    prev.byContext[key] = (prev.byContext[key] ?? 0) + 1;
  }
  
  prev.latency.count += 1;
  prev.latency.sum += durationMs;
  prev.latency.min = Math.min(prev.latency.min, durationMs);
  prev.latency.max = Math.max(prev.latency.max, durationMs);
  externalAgg.set(target, prev);
  toolCallsTotal += 1;
}

export function updateBreakerMetrics() {
  if (!gaugeBreakerState || !counterBreakerEvents) return;
  
  const breakerStats = getAllBreakerStats();
  for (const [target, stats] of Object.entries(breakerStats)) {
    const stateValue = stats.state === 'open' ? 1 : stats.state === 'halfOpen' ? 0.5 : 0;
    gaugeBreakerState.set({ target }, stateValue);
  }
}

/**
 * Record IRROPS processing metrics
 */
export function observeIrrops(
  disruptionType: string,
  optionsGenerated: number,
  durationMs: number,
  success: boolean = true
) {
  observeExternal(
    {
      target: 'irrops',
      status: success ? 'ok' : 'error',
      // Use target field to include disruption type for now
      // In production, would extend labels to include disruption_type
    },
    durationMs
  );
  
  // Could add specific IRROPS counters here if needed
  // For now, using existing external request pattern
}

/**
 * Record policy browser extraction metrics
 */
export function observePolicyBrowser(
  engine: 'playwright' | 'cheerio',
  durationMs: number,
  success: boolean = true,
  confidence?: number
) {
  observeExternal(
    {
      target: 'policy_browser',
      status: success ? 'ok' : 'error',
    },
    durationMs
  );
  
  // Log confidence for monitoring extraction quality
  if (confidence !== undefined) {
    console.log(`policy_browser_confidence: ${confidence.toFixed(2)} (${engine})`);
  }
}

export function incBreakerEvent(target: string, type: string) {
  if (counterBreakerEvents) {
    counterBreakerEvents.inc({ target, type });
  }
}

export function incRateLimitThrottled(target: string) {
  if (counterRateLimitThrottled) {
    counterRateLimitThrottled.inc({ target });
  }
}

export async function getPrometheusText(): Promise<string> {
  if (!IS_PROM) return '';
  await ensureProm();
  updateBreakerMetrics();
  return register ? register.metrics() : '';
}

export function snapshot() {
  const targets = Array.from(externalAgg.entries()).map(([target, agg]) => ({
    target,
    total: agg.total,
    byStatus: agg.byStatus,
    byContext: agg.byContext,
    latency: {
      count: agg.latency.count,
      avg_ms: agg.latency.count > 0 ? Number((agg.latency.sum / agg.latency.count).toFixed(1)) : 0,
      min_ms: agg.latency.count > 0 ? agg.latency.min : 0,
      max_ms: agg.latency.max,
    },
    timeout_rate: agg.total > 0 ? Number(((agg.byStatus['timeout'] ?? 0) / agg.total).toFixed(3)) : 0,
  }));
  
  // Pipeline stage metrics
  const stages = Array.from(new Set([
    ...Array.from(stageMetrics.success.keys()),
    ...Array.from(stageMetrics.failure.keys()),
    ...Array.from(stageMetrics.verify_success.keys()),
    ...Array.from(stageMetrics.verify_failure.keys())
  ])).map(key => {
    const success = stageMetrics.success.get(key) || 0;
    const failure = stageMetrics.failure.get(key) || 0;
    const total = success + failure;
    const latency = stageMetrics.latency.get(key);
    
    const verifySuccess = stageMetrics.verify_success.get(key) || 0;
    const verifyFailure = stageMetrics.verify_failure.get(key) || 0;
    const verifyTotal = verifySuccess + verifyFailure;
    
    return {
      stage: key,
      success_count: success,
      failure_count: failure,
      success_rate: total > 0 ? Number((success / total).toFixed(3)) : 0,
      verify_success_rate: verifyTotal > 0 ? Number((verifySuccess / verifyTotal).toFixed(3)) : undefined,
      latency: latency ? {
        count: latency.count,
        avg_ms: latency.count > 0 ? Number((latency.sum / latency.count).toFixed(1)) : 0,
        min_ms: latency.count > 0 ? latency.min : 0,
        max_ms: latency.max,
      } : null
    };
  });
  
  // Search quality metrics
  const searchQualityData = searchQuality.get('search_quality');
  let searchQualityResult = {};
  if (searchQualityData) {
    searchQualityResult = {
      total_searches: searchQualityData.total,
      complex_query_rate: searchQualityData.total > 0 ? 
        (searchQualityData.complexQueries / searchQualityData.total).toFixed(3) : '0.000',
      avg_complexity_confidence: searchQualityData.avgComplexityConfidence.count > 0 ?
        (searchQualityData.avgComplexityConfidence.sum / searchQualityData.avgComplexityConfidence.count).toFixed(3) : '0.000',
      upgrade_rate: searchQualityData.total > 0 ? 
        (searchUpgradeRequests / searchQualityData.total).toFixed(3) : '0.000',
      avg_results_per_search: searchQualityData.resultCounts.count > 0 ?
        (searchQualityData.resultCounts.sum / searchQualityData.resultCounts.count).toFixed(1) : '0.0'
    };
  }

  // Confidence correlation metrics
  const confidenceCorrelation = Array.from(confidenceOutcomes.entries()).map(([key, stats]) => {
    const totalHigh = stats.high_conf_success + stats.high_conf_fail;
    const totalLow = stats.low_conf_success + stats.low_conf_fail;
    
    return {
      stage: key,
      high_confidence: {
        total: totalHigh,
        success_rate: totalHigh > 0 ? Number((stats.high_conf_success / totalHigh).toFixed(3)) : 0
      },
      low_confidence: {
        total: totalLow,
        success_rate: totalLow > 0 ? Number((stats.low_conf_success / totalLow).toFixed(3)) : 0
      }
    };
  });
  
  // Include session store config
  const sessionStoreKind = process.env.SESSION_STORE || 'memory';
  const sessionTtlSec = Number(process.env.SESSION_TTL_SEC || 3600);
  
  return { 
    messages_total: messages, 
    chat_turns: chatTurns,
    router_low_conf: routerLowConf,
    router_confidence_buckets: routerConfidenceBuckets,
    clarify_requests: clarifyRequests,
    clarify_resolved: clarifyResolved,
    fallbacks,
    answers_with_citations_total: answersWithCitations,
    verify_fails: verifyFailsByReason,
    verify_pass_total: verifyPass,
    generated_answers_total: generatedAnswers,
    answers_using_external_data_total: answersUsingExternal,
    pipeline_stages: stages,
    confidence_correlation: confidenceCorrelation,
    search_quality: searchQualityResult,
    quality: {
      verify_pass_rate: generatedAnswers > 0 ? Number((verifyPass / generatedAnswers).toFixed(3)) : 0,
      verify_fail_rate: generatedAnswers > 0 ? Number((verifyFail / generatedAnswers).toFixed(3)) : 0,
      citation_coverage: answersUsingExternal > 0 ? Number((answersWithCitations / answersUsingExternal).toFixed(3)) : 0,
      clarification_efficacy: (() => {
        const totalReq = Object.values(clarifyRequests).reduce((a, b) => a + b, 0);
        const totalRes = Object.values(clarifyResolved).reduce((a, b) => a + b, 0);
        return totalReq > 0 ? Number((totalRes / totalReq).toFixed(3)) : 0;
      })(),
      verify_scores: {
        relevance: { count: verifyScores.relevance.count, avg: verifyScores.relevance.count > 0 ? Number((verifyScores.relevance.sum / verifyScores.relevance.count).toFixed(3)) : 0, buckets: verifyScores.relevance.buckets },
        grounding: { count: verifyScores.grounding.count, avg: verifyScores.grounding.count > 0 ? Number((verifyScores.grounding.sum / verifyScores.grounding.count).toFixed(3)) : 0, buckets: verifyScores.grounding.buckets },
        coherence: { count: verifyScores.coherence.count, avg: verifyScores.coherence.count > 0 ? Number((verifyScores.coherence.sum / verifyScores.coherence.count).toFixed(3)) : 0, buckets: verifyScores.coherence.buckets },
        context_consistency: { count: verifyScores.context_consistency.count, avg: verifyScores.context_consistency.count > 0 ? Number((verifyScores.context_consistency.sum / verifyScores.context_consistency.count).toFixed(3)) : 0, buckets: verifyScores.context_consistency.buckets },
      }
    },
    external_requests: { targets },
    performance: {
      e2e_latency_ms: {
        count: e2eHist.count,
        avg_ms: e2eHist.count > 0 ? Number((e2eHist.sum / e2eHist.count).toFixed(1)) : 0,
        min_ms: e2eHist.count > 0 ? e2eHist.min : 0,
        max_ms: e2eHist.max,
        buckets: e2eHist.buckets,
      },
      avg_tool_calls_per_conversation: (() => {
        const totalTurns = Object.values(chatTurns).reduce((a, b) => a + b, 0);
        return totalTurns > 0 ? Number((toolCallsTotal / totalTurns).toFixed(2)) : 0;
      })(),
      total_tool_calls: toolCallsTotal,
    },
    business: {
      total_sessions: totalSessions,
      resolved_sessions: resolvedSessions,
      fcr_rate: totalSessions > 0 ? Number((resolvedSessions / totalSessions).toFixed(3)) : 0,
      deflection_rate: totalSessions > 0 ? Number(((sessionOutcomes.auto || 0) / totalSessions).toFixed(3)) : 0,
      session_outcomes: sessionOutcomes,
      ttr_ms_by_intent: Object.fromEntries(Object.entries(ttrByIntent).map(([intent, a]) => [intent, {
        count: a.count,
        avg_ms: a.count > 0 ? Number((a.sum / a.count).toFixed(1)) : 0,
        min_ms: a.count > 0 ? a.min : 0,
        max_ms: a.max,
      }]))
    },
    breaker: { byTarget: getAllBreakerStats() },
    rate_limit: { byTarget: getAllLimiterStats() },
    session_store_kind: sessionStoreKind,
    session_ttl_sec: sessionTtlSec,
  };
}

export function metricsMode(): 'prom' | 'json' | 'off' {
  if (IS_PROM) return 'prom';
  if (IS_JSON) return 'json';
  return 'off';
}

// Ingestion from external processes (CLI) to merge metrics into this process snapshot
export function ingestEvent(name: string, labels?: Record<string, string>, value?: number) {
  switch (name) {
    case 'messages_total':
    case 'incMessages':
      incMessages();
      break;
    case 'stage_latency_ms': {
      const stage = (labels?.stage as any) || 'route';
      const intent = labels?.intent || 'unknown';
      const v = typeof value === 'number' ? value : 1;
      observeStage(stage, v, true, intent);
      break;
    }
    case 'stage_verify_success': {
      const intent = labels?.intent || 'unknown';
      const success = !!value;
      observeStage('verify', 1, success, intent);
      observeStageVerification('verify', intent, success);
      break;
    }
    case 'pipeline_stage_latency_ms': {
      const stage = (labels?.stage as any) || 'route';
      const intent = labels?.intent || 'unknown';
      const v = typeof value === 'number' ? value : 1;
      observeStage(stage, v, true, intent);
      break;
    }
    case 'pipeline_stage_outcome_total': {
      const stage = (labels?.stage as any) || 'route';
      const intent = labels?.intent || 'unknown';
      const outcome = (labels?.outcome as any) || 'success';
      const v = typeof value === 'number' ? value : 1;
      for (let i = 0; i < v; i++) {
        if (outcome === 'success') observeStage(stage, 1, true, intent);
        else if (outcome === 'fail') observeStage(stage, 1, false, intent);
        else if (outcome === 'clarify') observeStageClarify(stage, intent, 1);
        else if (outcome === 'escalated') observeStageEscalated(stage, intent, 1);
      }
      break;
    }
    case 'chat_turn_total':
      incTurn(labels?.intent || 'unknown');
      break;
    case 'router_low_conf_total':
      incRouterLowConf(labels?.intent || 'unknown');
      break;
    case 'clarify_total':
      incClarify(labels?.intent || 'unknown', labels?.slot || 'unknown');
      break;
    case 'clarify_resolved_total':
      incClarifyResolved(labels?.intent || 'unknown');
      break;
    case 'fallback_total':
      incFallback((labels?.kind as any) || 'web');
      break;
    case 'answers_with_citations_total':
      incAnswersWithCitations();
      break;
    case 'answers_using_external_data_total':
      incAnswerUsingExternal();
      break;
    case 'verify_fail_total':
      incVerifyFail(labels?.reason || 'unknown');
      break;
    case 'e2e_latency_ms':
      if (typeof value === 'number') observeE2E(value);
      break;
    case 'generated_answers_total':
      incGeneratedAnswer();
      break;
    case 'search_upgrade_request_total':
      // allow external processes to record upgrade requests
      searchUpgradeRequests += typeof value === 'number' ? Math.max(1, Math.floor(value)) : 1;
      break;
    case 'verify_pass_total':
      incVerifyPass();
      break;
    case 'session_start':
      if (labels?.threadId) startSession(labels.threadId, labels.intent);
      break;
    case 'session_resolve':
      if (labels?.threadId) resolveSession(labels.threadId, (labels.mode as any) || 'auto');
      break;
    default:
      // ignore unknown
      break;
  }
}

// Router confidence bucket observation
export function observeRouterConfidence(confidence: number) {
  const c = isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  if (c < 0.5) routerConfidenceBuckets['0.0-0.5'] = (routerConfidenceBuckets['0.0-0.5'] ?? 0) + 1;
  else if (c < 0.6) routerConfidenceBuckets['0.5-0.6'] = (routerConfidenceBuckets['0.5-0.6'] ?? 0) + 1;
  else if (c < 0.75) routerConfidenceBuckets['0.6-0.75'] = (routerConfidenceBuckets['0.6-0.75'] ?? 0) + 1;
  else if (c < 0.9) routerConfidenceBuckets['0.75-0.9'] = (routerConfidenceBuckets['0.75-0.9'] ?? 0) + 1;
  else routerConfidenceBuckets['0.9-1.0'] = (routerConfidenceBuckets['0.9-1.0'] ?? 0) + 1;
}

export function observeStageVerification(
  stage: 'guard'|'extract'|'route'|'gather'|'blend'|'verify',
  intent: string | null,
  verified: boolean
) {
  const key = intent ? `${stage}_${intent}` : stage;
  
  if (verified) {
    stageMetrics.verify_success.set(key, (stageMetrics.verify_success.get(key) || 0) + 1);
  } else {
    stageMetrics.verify_failure.set(key, (stageMetrics.verify_failure.get(key) || 0) + 1);
  }
}

export function observeStage(
  stage: 'guard'|'extract'|'route'|'gather'|'blend'|'verify',
  durationMs: number,
  success: boolean = true,
  intent?: string
) {
  const key = intent ? `${stage}_${intent}` : stage;
  
  // Track success/failure
  if (success) {
    stageMetrics.success.set(key, (stageMetrics.success.get(key) || 0) + 1);
    // v2
    const s = getStageIntentStats(stage, intent || '');
    s.outcomes.success += 1;
  } else {
    stageMetrics.failure.set(key, (stageMetrics.failure.get(key) || 0) + 1);
    const s = getStageIntentStats(stage, intent || '');
    s.outcomes.fail += 1;
  }
  
  // Track latency
  const latency = stageMetrics.latency.get(key) || { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0 };
  addLatency(latency, durationMs);
  stageMetrics.latency.set(key, latency);

  // v2 latency
  const s2 = getStageIntentStats(stage, intent || '');
  addLatency(s2.latency, durationMs);
}

export function observeRouterResult(
  intent: string,
  confidence: number,
  missingSlots: number,
  success?: boolean
) {
  observeRouterConfidence(confidence);
  
  // Track confidence correlation if success is known
  if (success !== undefined) {
    observeConfidenceOutcome('router', confidence, success, intent);
  }
  
  // Track missing slots as a quality indicator
  if (missingSlots > 0) {
    bump(clarifyRequests, `${intent}:missing_slots`);
  }

  // Track anomalies
  if (missingSlots > 0 && confidence >= 0.9) {
    const r = routerAnomalies.get(intent || 'unknown') || { high_conf_miss: 0, low_conf_hit: 0 };
    r.high_conf_miss += 1;
    routerAnomalies.set(intent || 'unknown', r);
  }
  if (missingSlots === 0 && confidence < 0.6 && success) {
    const r = routerAnomalies.get(intent || 'unknown') || { high_conf_miss: 0, low_conf_hit: 0 };
    r.low_conf_hit += 1;
    routerAnomalies.set(intent || 'unknown', r);
  }
}

export function observeSearchQuality(
  complexity: { isComplex: boolean; confidence: number },
  resultCount: number,
  upgradeRequested: boolean = false
) {
  const key = 'search_quality';
  
  const stats = searchQuality.get(key) || {
    total: 0,
    complexQueries: 0,
    avgComplexityConfidence: { sum: 0, count: 0 },
    resultCounts: { sum: 0, count: 0 }
  };
  
  stats.total += 1;
  if (complexity.isComplex) stats.complexQueries += 1;
  stats.avgComplexityConfidence.sum += complexity.confidence;
  stats.avgComplexityConfidence.count += 1;
  if (upgradeRequested) searchUpgradeRequests += 1;
  stats.resultCounts.sum += resultCount;
  stats.resultCounts.count += 1;
  
  searchQuality.set(key, stats);
}

export function observeConfidenceOutcome(
  stage: 'router'|'verify'|'search',
  confidence: number,
  success: boolean,
  intent?: string
) {
  const key = intent ? `${stage}_${intent}` : stage;
  const isHighConf = confidence > 0.7;
  
  const stats = confidenceOutcomes.get(key) || {
    high_conf_success: 0, high_conf_fail: 0,
    low_conf_success: 0, low_conf_fail: 0
  };
  
  if (isHighConf) {
    if (success) stats.high_conf_success += 1;
    else stats.high_conf_fail += 1;
  } else {
    if (success) stats.low_conf_success += 1;
    else stats.low_conf_fail += 1;
  }
  
  confidenceOutcomes.set(key, stats);
}

// Explicit stage outcome helpers for v2
export function observeStageClarify(stage: StageName, intent: string | undefined, durationMs: number) {
  const s = getStageIntentStats(stage, intent || '');
  s.outcomes.clarify += 1;
  addLatency(s.latency, durationMs);
}
export function observeStageEscalated(stage: StageName, intent: string | undefined, durationMs: number) {
  const s = getStageIntentStats(stage, intent || '');
  s.outcomes.escalated += 1;
  addLatency(s.latency, durationMs);
}

// New JSON snapshot (v2)
export function snapshotV2() {
  // Pipeline stages with separate stage and intent
  const stages: Array<{ stage: StageName; intent: string; totals: Record<Outcome, number>; latency: { p50: number; p95: number; max: number } }>
    = [];
  for (const [stage, byIntent] of pipelineStats.entries()) {
    for (const [intent, stats] of byIntent.entries()) {
      stages.push({
        stage,
        intent,
        totals: { ...stats.outcomes },
        latency: {
          p50: percentile(stats.latency.samples, 50),
          p95: percentile(stats.latency.samples, 95),
          max: stats.latency.max,
        }
      });
    }
  }

  // Intent health aggregation
  const intentAgg = new Map<string, { requests: number; clarifications: number; verifyFails: number; totalTurns: number; turnLatencySum: number; turnCount: number }>();
  // Use route totals as requests, clarify totals as clarifications, verify failures from stage verify
  const byIntentRoute = pipelineStats.get('route') || new Map();
  for (const [intent, stats] of byIntentRoute.entries()) {
    const a = intentAgg.get(intent) || { requests: 0, clarifications: 0, verifyFails: 0, totalTurns: 0, turnLatencySum: 0, turnCount: 0 };
    a.requests += (stats.outcomes.success + stats.outcomes.clarify + stats.outcomes.fail + stats.outcomes.escalated);
    a.clarifications += stats.outcomes.clarify;
    intentAgg.set(intent, a);
  }
  const byIntentVerify = pipelineStats.get('verify') || new Map();
  for (const [intent, stats] of byIntentVerify.entries()) {
    const a = intentAgg.get(intent) || { requests: 0, clarifications: 0, verifyFails: 0, totalTurns: 0, turnLatencySum: 0, turnCount: 0 };
    a.verifyFails += stats.outcomes.fail;
    intentAgg.set(intent, a);
  }
  // Use blend latency as proxy for turn latency
  const byIntentBlend = pipelineStats.get('blend') || new Map();
  for (const [intent, stats] of byIntentBlend.entries()) {
    const a = intentAgg.get(intent) || { requests: 0, clarifications: 0, verifyFails: 0, totalTurns: 0, turnLatencySum: 0, turnCount: 0 };
    a.turnLatencySum += stats.latency.sum;
    a.turnCount += stats.latency.count;
    intentAgg.set(intent, a);
  }
  const intents = Array.from(intentAgg.entries()).map(([intent, a]) => ({
    intent,
    requests: a.requests,
    clarification_rate: a.requests > 0 ? Number((a.clarifications / a.requests).toFixed(3)) : 0,
    fallback_rate: 0, // not attributed per-intent in current impl
    verify_fail_rate: a.requests > 0 ? Number((a.verifyFails / a.requests).toFixed(3)) : 0,
    avg_turn_latency: a.turnCount > 0 ? Number((a.turnLatencySum / a.turnCount).toFixed(1)) : 0,
  }));

  // Verify quality breakdown
  const verify = Object.entries(verifyFailsByReason).map(([reason, count]) => ({ reason, count }));
  const confidence = Array.from(confidenceOutcomes.entries()).map(([key, s]) => {
    const [stage, intent] = key.includes('_') ? ((): [string, string] => { const i = key.indexOf('_'); return [key.slice(0, i), key.slice(i + 1)]; })() : [key, ''];
    const totalHigh = s.high_conf_success + s.high_conf_fail;
    const totalLow = s.low_conf_success + s.low_conf_fail;
    return {
      stage,
      intent,
      high: { total: totalHigh, success_rate: totalHigh > 0 ? Number((s.high_conf_success / totalHigh).toFixed(3)) : 0 },
      low: { total: totalLow, success_rate: totalLow > 0 ? Number((s.low_conf_success / totalLow).toFixed(3)) : 0 },
    };
  });

  // Search aggregation (reuse previous)
  const sq = searchQuality.get('search_quality');
  const search = sq ? {
    total: sq.total,
    complex_query_rate: sq.total > 0 ? Number((sq.complexQueries / sq.total).toFixed(3)) : 0,
    avg_complexity_confidence: sq.avgComplexityConfidence.count > 0 ? Number((sq.avgComplexityConfidence.sum / sq.avgComplexityConfidence.count).toFixed(3)) : 0,
    upgrade_rate: sq.total > 0 ? Number((searchUpgradeRequests / sq.total).toFixed(3)) : 0,
    avg_results_per_search: sq.resultCounts.count > 0 ? Number((sq.resultCounts.sum / sq.resultCounts.count).toFixed(1)) : 0,
  } : { total: 0, complex_query_rate: 0, avg_complexity_confidence: 0, upgrade_rate: 0, avg_results_per_search: 0 };

  // External aggregation
  const targets = Array.from(externalAgg.entries()).map(([target, agg]) => ({
    target,
    total: agg.total,
    byStatus: agg.byStatus,
    byContext: agg.byContext,
    latency: {
      avg_ms: agg.latency.count > 0 ? Number((agg.latency.sum / agg.latency.count).toFixed(1)) : 0,
      max_ms: agg.latency.max,
    },
    timeout_rate: agg.total > 0 ? Number(((agg.byStatus['timeout'] ?? 0) / agg.total).toFixed(3)) : 0,
  }));

  // LLM placeholder (can be populated later)
  const llm = {};

  // System block
  const active_sessions = Array.from(sessions.values()).filter(s => !s.resolved).length;
  const system = {
    active_sessions,
    breaker: getAllBreakerStats(),
    rate_limit: getAllLimiterStats(),
  };

  // Alerts (basic rules)
  const alerts: Array<{ message: string; level: 'warn'|'alert' }>
    = [];
  for (const s of stages) {
    const total = s.totals.success + s.totals.clarify + s.totals.fail + s.totals.escalated;
    if (total === 0) continue;
    const successRate = s.totals.success / total;
    if (successRate < 0.9) alerts.push({ message: `${s.stage}/${s.intent} success ${(successRate*100).toFixed(1)}%`, level: 'alert' });
    if (s.latency.p95 > 5000) alerts.push({ message: `${s.stage}/${s.intent} p95 ${s.latency.p95.toFixed(0)}ms`, level: 'warn' });
  }
  for (const t of targets) {
    if (t.timeout_rate > 0.05) alerts.push({ message: `${t.target} timeouts ${(t.timeout_rate*100).toFixed(1)}%`, level: 'alert' });
  }

  return {
    pipeline: { stages, alerts },
    intents,
    quality: { verify, confidence },
    search,
    external: { targets },
    llm,
    system,
  };
}
