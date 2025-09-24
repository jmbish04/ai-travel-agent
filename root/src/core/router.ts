import { RouterResult, RouterResultT } from '../schemas/router.js';
import { getPrompt } from './prompts.js';
import { callLLM } from './llm.js';
import {
  getThreadSlots,
  updateThreadSlots,
  normalizeSlots,
  clearThreadSlots,
  getLastUserMessage,
  resolveLocationPlaceholder,
  isTemporalReference,
} from './slot_memory.js';
import { extractSlots, extractFlightSlotsOnce, parseCity } from './parsers.js';
import { transformersEnabled } from '../config/transformers.js';
import { RE, isDirectFlightHeuristic } from './router.optimizers.js';
import type pino from 'pino';
import { incTurn, incRouterLowConf, noteTurn, observeRouterConfidence } from '../util/metrics.js';
import { classifyConsentResponse } from './consent.js';
import { assessQueryComplexity } from './complexity.js';

const LOCATION_SLOT_KEYS = [
  'city',
  'destinationCity',
  'originCity',
  'country',
  'countryName',
  'region',
  'state',
  'stateOrProvince',
];

const TIME_SLOT_KEYS = [
  'month',
  'dates',
  'departureDate',
  'returnDate',
  'travelWindow',
  'season',
  'checkIn',
  'checkOut',
  'travelDates',
];

const PROFILE_SLOT_KEYS = [
  'travelerProfile',
  'travelStyle',
  'groupType',
  'budgetLevel',
  'activityType',
  'tripPurpose',
];

const CONSENT_SLOT_KEYS = [
  'awaiting_search_consent',
  'pending_search_query',
  'awaiting_deep_research_consent',
  'pending_deep_research_query',
  'awaiting_web_search_consent',
  'pending_web_search_query',
  'awaiting_flight_clarification',
  'pending_flight_query',
  'flight_clarification_needed',
  'clarification_options',
  'clarification_reasoning',
  'ambiguity_reason',
];

const AUX_SLOT_KEYS = ['complexity_score', 'complexity_reasoning'];

const RESET_SLOT_KEYS = Array.from(new Set([
  ...LOCATION_SLOT_KEYS,
  ...TIME_SLOT_KEYS,
  ...PROFILE_SLOT_KEYS,
  ...CONSENT_SLOT_KEYS,
  ...AUX_SLOT_KEYS,
]));

const PROMPT_CONTEXT_OMIT_PREFIXES = ['awaiting_', 'pending_'];
const PROMPT_CONTEXT_BLOCKLIST = new Set([
  'complexity_reasoning',
  'complexity_score'
]);

function formatContextForRouter(slots: Record<string, string>): string {
  if (!slots || Object.keys(slots).length === 0) return '{}';
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(slots)) {
    if (!value || !value.trim()) continue;
    if (PROMPT_CONTEXT_BLOCKLIST.has(key)) continue;
    if (PROMPT_CONTEXT_OMIT_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    filtered[key] = value.trim();
  }
  const entries = Object.entries(filtered)
    .slice(0, 10); // safeguard prompt length
  if (entries.length === 0) return '{}';
  try {
    return JSON.stringify(Object.fromEntries(entries));
  } catch {
    return '{}';
  }
}

// Deprecated probes removed; consent classification handled by classifyConsentResponse.

function normalizeLocationName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

function getPrimaryLocation(slots: Record<string, string>): string | undefined {
  for (const key of ['city', 'destinationCity', 'country', 'originCity', 'region', 'state', 'countryName']) {
    if (slots[key]) return slots[key];
  }
  return undefined;
}

async function shouldSkipContextDetector(message: string, log?: pino.Logger): Promise<boolean> {
  const trimmed = message.trim();
  if (!trimmed) return true;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 2) return true;
  const verdict = await classifyConsentResponse(trimmed, log);
  return verdict === 'yes' || verdict === 'unclear';
}

async function callContextSwitchDetector(previous: string, current: string, log?: pino.Logger): Promise<boolean> {
  try {
    const prompt = await getPrompt('context_switch_detector');
    const filled = prompt
      .replace('{previous_query}', previous)
      .replace('{current_query}', current);
    const response = await callLLM(filled, { responseFormat: 'text', log });
    const verdict = response.trim().toUpperCase();
    return verdict.startsWith('DIFFERENT');
  } catch (err) {
    log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'context_switch_detector_failed');
    return false;
  }
}

function stripSlotKeys(slots: Record<string, string>, keys: Iterable<string>): void {
  for (const key of keys) {
    if (key in slots) {
      delete slots[key];
    }
  }
}

// Context resets moved to slot_memory.normalizeSlots; router no longer mutates context.

// Helper function to clear consent state for unrelated queries
// Consent state is managed via slot_memory.writeConsentState

export async function routeIntent({ message, threadId, logger }: {
  message: string; 
  threadId?: string; 
  logger?: {log: pino.Logger}
}): Promise<RouterResultT> {
  logger?.log?.debug({ message }, 'router_start');
  const m = message.trim();

  // 0) Guard: empty input
  if (!m) {
    return RouterResult.parse({ intent: 'unknown', needExternal: false, slots: {}, confidence: 0.1 });
  }

  // Load context
  let ctxSlots = await loadCtxSlots(threadId);

  // Flight clarification state
  const clarification = await maybeHandleFlightClarification(m, threadId, ctxSlots, logger?.log);
  if (clarification) return clarification;

  // Flight fast-path
  const flightFast = await maybeRouteFlightsFastPath(m, threadId, ctxSlots, logger?.log);
  if (flightFast) return flightFast;

  // Deep-research consent gate
  const deepConsent = await maybeGateDeepResearch(m, threadId, logger?.log);
  if (deepConsent) return deepConsent;

  // Transformers-first
  const viaTf = await maybeTransformersFirst(m, threadId, ctxSlots, logger);
  if (viaTf) return viaTf;

  // LLM router and post-processing
  return await runLlmRouteAndPostProcess(m, threadId, ctxSlots, logger);
}

async function loadCtxSlots(threadId?: string): Promise<Record<string, string>> {
  if (!threadId) return {};
  return await getThreadSlots(threadId);
}

// Consent clearing handled in graph guard stage only

function includesAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

async function maybeHandleFlightClarification(
  message: string,
  threadId: string | undefined,
  ctxSlots: Record<string, string>,
  log?: pino.Logger,
): Promise<RouterResultT | undefined> {
  if (!(ctxSlots.awaiting_flight_clarification === 'true' && threadId)) return undefined;

  const pendingQuery = ctxSlots.pending_flight_query || '';
  await updateThreadSlots(threadId, {}, [], [
    'awaiting_flight_clarification',
    'pending_flight_query',
    'clarification_reasoning',
  ]);

  if (includesAny(message, ['direct', 'search', 'booking'])) {
    // Avoid additional LLM slot extraction here; domain node will clarify if needed
    log?.debug({ choice: 'direct_search' }, 'flight_clarification_resolved');
    return RouterResult.parse({
      intent: 'flights',
      needExternal: true,
      slots: { ...ctxSlots },
      confidence: 0.9,
    });
  }
  if (includesAny(message, ['research', 'planning', 'advice'])) {
    log?.debug({ choice: 'web_research' }, 'flight_clarification_resolved');
    return RouterResult.parse({
      intent: 'web_search',
      needExternal: true,
      slots: { ...ctxSlots, search_query: pendingQuery },
      confidence: 0.9,
    });
  }
  log?.debug({ choice: 'process_current' }, 'flight_clarification_ambiguous');
  return undefined;
}

async function maybeRouteFlightsFastPath(
  message: string,
  threadId: string | undefined,
  ctxSlots: Record<string, string>,
  log?: pino.Logger,
): Promise<RouterResultT | undefined> {
  if (!RE.flights.test(message)) return undefined;
  const { isDirect } = isDirectFlightHeuristic(message);
  if (!isDirect) return undefined;
  // Fast-path with minimal slot extraction to avoid stale ctx slots
  const extracted = await extractFlightSlotsOnce(message, ctxSlots, log);
  const merged = normalizeSlots(ctxSlots, extracted, 'flights');
  const result = RouterResult.parse({ intent: 'flights', needExternal: true, slots: merged, confidence: 0.85 });
  incTurn(result.intent);
  try { observeRouterConfidence(result.confidence); } catch {}
  if (threadId) noteTurn(threadId, result.intent);
  return result;
}

async function maybeGateDeepResearch(
  message: string,
  threadId: string | undefined,
  log?: pino.Logger,
): Promise<RouterResultT | undefined> {
  if (process.env.DEEP_RESEARCH_ENABLED !== 'true') return undefined;
  const assessment = await assessQueryComplexity(message, log);
  if (!(assessment.isComplex && assessment.confidence >= 0.75)) return undefined;
  // Consent state managed elsewhere; do not mutate here
  const complexityScore = assessment.confidence.toFixed(2);
  if (threadId) {
    await updateThreadSlots(threadId, {
      awaiting_deep_research_consent: 'true',
      pending_deep_research_query: message,
      complexity_reasoning: assessment.reasoning,
      complexity_score: complexityScore,
    }, []);
  }
  log?.debug({ assessment }, 'complexity_consent_gate');
  return RouterResult.parse({
    intent: 'system', needExternal: false,
    slots: { deep_research_consent_needed: 'true', complexity_score: complexityScore },
    confidence: 0.9,
  });
}

async function maybeTransformersFirst(
  message: string,
  threadId: string | undefined,
  ctxSlots: Record<string, string>,
  logger?: { log: pino.Logger },
): Promise<RouterResultT | undefined> {
  if (!transformersEnabled()) return undefined;
  const tfm = await routeViaTransformersFirst(message, threadId, logger);
  if (!tfm) return undefined;
  if (tfm.intent === 'flights') {
    const refined = await extractSlots(message, ctxSlots, logger?.log);
    return RouterResult.parse({ ...tfm, slots: { ...tfm.slots, ...refined } });
  }
  const r = RouterResult.parse(tfm);
  incTurn(r.intent);
  try { observeRouterConfidence(r.confidence); } catch {}
  if (r.confidence < 0.6) incRouterLowConf(r.intent);
  if (threadId) noteTurn(threadId, r.intent);
  return r;
}

async function runLlmRouteAndPostProcess(
  message: string,
  threadId: string | undefined,
  ctxSlots: Record<string, string>,
  logger?: { log: pino.Logger },
): Promise<RouterResultT> {
  const promptTemplate = await getPrompt('router_llm');
  const prompt = promptTemplate
    .replace('{message}', message)
    .replace('{context}', formatContextForRouter(ctxSlots))
    .replace('{instructions}', '');
  logger?.log?.debug({ message, promptLength: prompt.length }, 'router_llm_call_start');
  const raw = await callLLM(prompt, { responseFormat: 'json', log: logger?.log });
  logger?.log?.debug({ rawResponse: raw, message }, 'router_llm_raw_response');
  const llm = RouterResult.parse(JSON.parse(raw));
  logger?.log?.debug({ parsedResult: llm, message }, 'router_llm_parsed_result');

  const normalizedSlots = normalizeSlots(ctxSlots, llm.slots, llm.intent);
  let llmNormalized: RouterResultT = { ...llm, slots: normalizedSlots } as RouterResultT;

  // Heuristic anchor: packing keywords should route to packing (not web_search)
  // Keeps one LLM call per turn while stabilizing UX for common phrasing
  const PACKING_RE = /\b(pack|packing|bring)\b/i;
  if (llmNormalized.intent === 'web_search' && PACKING_RE.test(message)) {
    llmNormalized = RouterResult.parse({
      intent: 'packing',
      needExternal: true, // packing uses weather facts
      slots: normalizeSlots(ctxSlots, llm.slots || {}, 'packing'),
      confidence: Math.max(0.8, llmNormalized.confidence),
    });
  }
  logger?.log?.debug({ intent: llmNormalized.intent, confidence: Number(llmNormalized.confidence.toFixed(2)) }, 'router_final_result');
  incTurn(llmNormalized.intent);
  try { observeRouterConfidence(llmNormalized.confidence); } catch {}
  if (llmNormalized.confidence < 0.6) incRouterLowConf(llmNormalized.intent);
  if (threadId) noteTurn(threadId, llmNormalized.intent);
  return llmNormalized;
}

// Make classifyIntentFromTransformers LLM-free
async function classifyIntentFromTransformers(
  message: string, 
  intentResult: any,
  entityResult: any,
  slots: any, 
  log?: pino.Logger
): Promise<{ intent: string; needExternal: boolean; confidence: number } | undefined> {
  
  const intent = intentResult.intent;
  let confidence = intentResult.confidence ?? 0.7;
  const hasLoc = !!slots.city || (entityResult.locations?.length > 0);
  const needExternal = (intent === 'weather' || intent === 'destinations') ? true
                     : (intent === 'attractions' ? hasLoc : intent === 'flights');

  // Small regex bumps
  if (intent === 'weather' && RE.weather.test(message)) confidence = Math.max(confidence, 0.85);

  return { intent, needExternal, confidence };
}

async function routeViaTransformersFirst(
  message: string,
  threadId?: string,
  logger?: { log: pino.Logger },
): Promise<RouterResultT | undefined> {
  const log = logger?.log;
  const timeoutMs = Math.max(100, Number(process.env.TRANSFORMERS_ROUTER_TIMEOUT_MS ?? '3000'));
  
  let timedOut = false;
  const timer = new Promise<undefined>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve(undefined);
    }, timeoutMs);
  });

  const started = Date.now();
  const result = await Promise.race([
    tryRouteViaTransformers(message, threadId, log),
    timer,
  ]);
  const durationMs = Date.now() - started;

  if (!result || timedOut) {
    log?.debug({ success: false, reason: timedOut ? 'timeout' : 'low_confidence', durationMs }, 'transformers_skipped');
    return undefined;
  }

  if (result.confidence >= 0.7) {
    log?.debug({ success: true, durationMs, intent: result.intent, confidence: result.confidence }, 'transformers_accepted');
    return RouterResult.parse(result);
  }

  return undefined;
}

async function tryRouteViaTransformers(message: string, threadId?: string, log?: pino.Logger): Promise<RouterResultT | undefined> {
  try {
    // Use enhanced NER for better entity extraction
    const { extractEntitiesEnhanced } = await import('./ner-enhanced.js');
    const entityResult = await extractEntitiesEnhanced(message, log);
    
    // Use transformers-based intent classification
    const { classifyIntent } = await import('./transformers-classifier.js');
    const intentResult = await classifyIntent(message, log);

    // Get thread context for slot merging
    const ctxSlots = threadId ? await getThreadSlots(threadId) : {};
    // Avoid additional LLM calls in transformers path; rely on ctxSlots only
    const extractedSlots: Record<string, string> = {};
    
    // Enhanced intent classification based on transformers results (NO LLM)
    const intent = await classifyIntentFromTransformers(message, intentResult, entityResult, extractedSlots, log);
    
    if (intent && intent.confidence > 0.7) {
      return RouterResult.parse({
        intent: intent.intent,
        needExternal: intent.needExternal,
        slots: { ...ctxSlots, ...extractedSlots },
        confidence: intent.confidence
      });
    }
    
    return undefined;
  } catch (error) {
    log?.debug({ error: String(error) }, 'transformers_failed');
    return undefined;
  }
}
