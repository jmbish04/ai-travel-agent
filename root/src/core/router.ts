import { RouterResult, RouterResultT } from '../schemas/router.js';
import { getPrompt } from './prompts.js';
import { callLLM, optimizeSearchQuery } from './llm.js';
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

// AI-first detection functions using existing prompts
async function isPronounFollowup(message: string, log?: pino.Logger): Promise<boolean> {
  // Use consent_detector to identify vague/unclear responses (pronouns typically create unclear responses)
  const consentPrompt = await getPrompt('consent_detector');
  const result = await callLLM(
    consentPrompt + `\n\nUser message: "${message}"`,
    { responseFormat: 'text' }
  );
  return result.trim().toLowerCase() === 'unclear';
}

async function isQuickAck(message: string, log?: pino.Logger): Promise<boolean> {
  // Use consent_detector to identify positive acknowledgments
  const consentPrompt = await getPrompt('consent_detector');
  const result = await callLLM(
    consentPrompt + `\n\nUser message: "${message}"`,
    { responseFormat: 'text' }
  );
  return result.trim().toLowerCase() === 'yes';
}

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

async function maybeResetContextForMessage(params: {
  threadId?: string;
  message: string;
  slots: Record<string, string>;
  newSlots?: Record<string, string | null | undefined>;
  logger?: pino.Logger;
}): Promise<{ slots: Record<string, string>; reset: boolean; reason?: string }> {
  const { threadId, message, logger } = params;
  const sanitizedSlots = { ...params.slots };
  const previousLocation = getPrimaryLocation(sanitizedSlots);
  let reset = false;
  let reason: string | undefined;
  const shouldSkip = await shouldSkipContextDetector(message, params.logger);
  const lastMessage = threadId ? await getLastUserMessage(threadId) : undefined;

  let freshSlots: Record<string, string> = {};
  if (params.newSlots) {
    for (const [key, value] of Object.entries(params.newSlots)) {
      if (typeof value === 'string' && value.trim()) {
        freshSlots[key] = value.trim();
      }
    }
  } else {
    try {
      freshSlots = await extractSlots(message, sanitizedSlots, logger);
    } catch (error) {
      logger?.debug({ err: String(error) }, 'context_slots_extraction_failed');
    }
  }

  const fallbackDestination = sanitizedSlots.destinationCity?.trim() || sanitizedSlots.city?.trim();
  const fallbackOrigin = sanitizedSlots.originCity?.trim() || sanitizedSlots.city?.trim();
  const fallbackCity = sanitizedSlots.city?.trim() || fallbackDestination || fallbackOrigin;

  // If the current message uses placeholder location terms ("there", "here", etc.),
  // prefer prior context over any newly inferred concrete city to prevent drift.
  // This avoids LLM mis-inference like mapping "there" to an unrelated city.
  const hasPlaceholderRef = /\b(there|here|that\s+(place|city|destination)|same\s*(place|destination|city)|the\s*same\s*(place|destination|city))\b/i.test(message);

  for (const key of ['destinationCity', 'city', 'originCity'] as const) {
    const value = freshSlots[key];
    if (typeof value === 'string') {
      let fallback: string | undefined;
      if (key === 'destinationCity') {
        fallback = fallbackDestination || fallbackCity;
      } else if (key === 'originCity') {
        fallback = fallbackOrigin || fallbackDestination || fallbackCity;
      } else {
        fallback = fallbackCity || fallbackDestination || fallbackOrigin;
      }
      // Resolve explicit placeholder tokens first
      let resolved = resolveLocationPlaceholder(value, fallback || previousLocation);
      // If message itself contains placeholder reference, force-resolve to prior context
      if (hasPlaceholderRef && !resolved && (fallback || previousLocation)) {
        resolved = (fallback || previousLocation)!;
      }
      if (resolved) {
        freshSlots[key] = resolved;
      } else {
        delete freshSlots[key];
      }
    }
  }

  const newLocation = getPrimaryLocation(freshSlots);
  
  // Check if only origin was added/changed and destination exists in prior context
  const priorDest = sanitizedSlots.destinationCity || sanitizedSlots.city;
  const newDest = freshSlots.destinationCity || freshSlots.city;
  const onlyOriginChanged = freshSlots.originCity && !newDest && !!priorDest;

  if (previousLocation && newLocation) {
    if (onlyOriginChanged) {
      // Don't reset if only origin was added and we have a prior destination
      reset = false;
    } else if (normalizeLocationName(previousLocation) !== normalizeLocationName(newLocation)) {
      reset = true;
      reason = 'new_location';
    }
  }

  if (!reset && threadId && previousLocation && !shouldSkip && lastMessage) {
    const different = await callContextSwitchDetector(lastMessage, message, logger);
    if (different) {
      reset = true;
      reason = 'llm_detector';
    }
  }

  if (reset && threadId) {
    await updateThreadSlots(threadId, {}, [], RESET_SLOT_KEYS);
    stripSlotKeys(sanitizedSlots, RESET_SLOT_KEYS);
    logger?.debug({ reason, previousLocation, newLocation }, 'context_switch_reset');
  } else {
    const hasTimeSignal = Boolean(
      freshSlots.month || freshSlots.dates || freshSlots.departureDate || freshSlots.returnDate || freshSlots.travelDates,
    );
    if (!hasTimeSignal) {
      stripSlotKeys(sanitizedSlots, TIME_SLOT_KEYS);
    }

    const hasProfileSignal = Boolean(
      freshSlots.travelerProfile ||
      freshSlots.travelStyle ||
      freshSlots.groupType ||
      freshSlots.budgetLevel ||
      freshSlots.activityType ||
      freshSlots.tripPurpose,
    );
    if (!hasProfileSignal) {
      stripSlotKeys(sanitizedSlots, PROFILE_SLOT_KEYS);
    }

    stripSlotKeys(sanitizedSlots, AUX_SLOT_KEYS);
  }

  return { slots: sanitizedSlots, reset, reason };
}

// Helper function to clear consent state for unrelated queries
async function clearConsentState(threadId?: string) {
  if (!threadId) return;
  
  // List of keys to remove - only consent and conflicting travel data
  const keysToRemove = [
    // Consent states only (do not clear travel context here)
    'awaiting_deep_research_consent',
    'pending_deep_research_query',
    'awaiting_web_search_consent',
    'pending_web_search_query',
    'awaiting_search_consent',
    'pending_search_query',
    'deep_research_consent_needed',
    // Aux reasoning signals
    'complexity_score',
    'complexity_reasoning',
    // Flight clarification-only workflow flags
    'flight_clarification_needed',
    'ambiguity_reason',
    'clarification_options',
    'awaiting_flight_clarification',
    'pending_flight_query',
    'clarification_reasoning',
  ];
  
  // Remove only the specified keys, preserving receipts and session data
  await updateThreadSlots(threadId, {}, [], keysToRemove);
}

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

  // Clear stale consent for unrelated queries
  ctxSlots = await maybeClearStaleConsent(m, threadId, ctxSlots, logger?.log);

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

async function maybeClearStaleConsent(
  message: string,
  threadId: string | undefined,
  ctxSlots: Record<string, string>,
  log?: pino.Logger,
): Promise<Record<string, string>> {
  if (!threadId) return ctxSlots;
  if (ctxSlots.awaiting_deep_research_consent !== 'true') return ctxSlots;

  const isDebug = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
  if (isDebug) console.debug(`🔍 CONSENT: Found awaiting_deep_research_consent, checking if "${message}" is a consent response`);
  const verdict = await classifyConsentResponse(message, log);
  if (isDebug) console.debug(`🔍 CONSENT: Verdict for "${message}": ${verdict}`);
  if (verdict === 'unclear') {
    if (isDebug) console.debug('🔍 CONSENT: Clearing consent state due to unclear verdict');
    await clearConsentState(threadId);
    const reloaded = await getThreadSlots(threadId);
    if (isDebug) console.debug('🔍 CONSENT: Slots after clearing:', reloaded);
    return reloaded;
  }
  if (isDebug) console.debug(`🔍 CONSENT: Not clearing consent state, verdict was: ${verdict}`);
  return ctxSlots;
}

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
    const flightSlots = await extractFlightSlotsOnce(pendingQuery, ctxSlots, log);
    log?.debug({ choice: 'direct_search', slots: flightSlots }, 'flight_clarification_resolved');
    return RouterResult.parse({
      intent: 'flights',
      needExternal: true,
      slots: { ...ctxSlots, ...flightSlots },
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
  await clearConsentState(threadId);
  const slots = await extractFlightSlotsOnce(message, ctxSlots, log);
  log?.debug({ isDirect: true, slots }, '✈️ FLIGHTS: direct (heuristic_llm_unified)');
  const result = RouterResult.parse({ intent: 'flights', needExternal: true, slots, confidence: 0.9 });
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
  await clearConsentState(threadId);
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

  let currentSlots = ctxSlots;
  if (threadId) {
    const resetResult = await maybeResetContextForMessage({
      threadId,
      message,
      slots: currentSlots,
      newSlots: llm.slots,
      logger: logger?.log,
    });
    currentSlots = resetResult.slots;
  }

  const normalizedSlots = normalizeSlots(currentSlots, llm.slots, llm.intent);
  let llmNormalized: RouterResultT = { ...llm, slots: normalizedSlots } as RouterResultT;

  // AI-first guard: do not allow LLM to invent a new location when the user
  // did not explicitly mention any. Use LLM city parser to confirm.
  try {
    const priorPrimary = getPrimaryLocation(currentSlots);
    const cityProbe = await parseCity(message, currentSlots, logger?.log);
    const hasExplicitCity = Boolean(cityProbe?.success && cityProbe.normalized);
    if (!hasExplicitCity && !priorPrimary && llmNormalized.slots) {
      const gated = { ...llmNormalized.slots } as Record<string, string>;
      for (const key of ['city', 'destinationCity', 'originCity'] as const) {
        if (!(currentSlots as any)[key] && (llm.slots as any)?.[key]) {
          delete gated[key];
        }
      }
      llmNormalized = RouterResult.parse({ ...llmNormalized, slots: normalizeSlots(currentSlots, gated, llm.intent) });
    }
  } catch (e) {
    logger?.log?.debug({ error: String(e) }, 'explicit_city_guard_failed');
  }

  // Flights post-processing
  // Anchor override: if user explicitly asked about weather, do not route to flights.
  // Keeps behavior AI-first by respecting user’s intent tokens and avoiding
  // LLM drift from prior context.
  if (
    llmNormalized.intent === 'flights' &&
    RE.weather.test(message) &&
    !RE.flights.test(message)
  ) {
    llmNormalized = RouterResult.parse({
      intent: 'weather',
      needExternal: true,
      slots: normalizeSlots(currentSlots, llmNormalized.slots || {}, 'weather'),
      confidence: Math.min(0.9, llmNormalized.confidence),
    });
  }

  // Flights post-processing
  if (llmNormalized.intent === 'flights') {
    try {
      const enhancedSlots = await extractFlightSlotsOnce(message, currentSlots, logger?.log);
      const preservedSlots = { ...enhancedSlots } as Record<string, string>;
      if (llmNormalized.slots?.dates && isTemporalReference(llmNormalized.slots.dates)) {
        preservedSlots.dates = llmNormalized.slots.dates;
        preservedSlots.departureDate = llmNormalized.slots.dates;
        delete (preservedSlots as any).month;
      }
      const mergedSlots = { ...enhancedSlots, ...llmNormalized.slots, ...preservedSlots };
      const normalizedMerged = normalizeSlots(currentSlots, mergedSlots, 'flights');
      logger?.log?.debug({ llmSlots: llmNormalized.slots, enhancedSlots, preservedSlots, mergedSlots }, 'flights_slot_enhancement');
      llmNormalized = RouterResult.parse({ ...llmNormalized, slots: normalizedMerged });
      logger?.log?.debug({ intent: llmNormalized.intent, confidence: llmNormalized.confidence }, 'router_final_result');
      return llmNormalized;
    } catch (error) {
      logger?.log?.debug({ error: String(error) }, 'flights_slot_enhancement_failed');
    }
  }

  // Heuristic log
  if (llmNormalized.intent === 'flights' && !RE.dateish.test(message)) {
    logger?.log?.debug({ reason: 'missing_date' }, 'flights_missing_date');
  }

  // (moved earlier, before flight-specific processing)

  // Correction pass
  if (llmNormalized.confidence < 0.6 || llmNormalized.intent === 'unknown') {
    try {
      const { classifyIntent } = await import('./llm.js');
      const det = await classifyIntent(message, currentSlots, logger?.log);
      if (det && det.confidence >= 0.75 && det.intent !== 'unknown') {
        const corrected = RouterResult.parse({
          intent: det.intent,
          needExternal: det.needExternal,
          slots: normalizeSlots(currentSlots, (det.slots as Record<string, string>) || {}, det.intent),
          confidence: det.confidence,
        });
        incTurn(corrected.intent);
        try { observeRouterConfidence(corrected.confidence); } catch {}
        if (corrected.confidence < 0.6) incRouterLowConf(corrected.intent);
        if (threadId) noteTurn(threadId, corrected.intent);
        logger?.log?.debug({ intent: corrected.intent, confidence: corrected.confidence }, 'router_final_result');
        return corrected;
      }
    } catch (e) {
      logger?.log?.debug({ error: String(e) }, 'nlp_intent_detection_correction_failed');
    }
  }

  logger?.log?.debug({ intent: llmNormalized.intent, confidence: llmNormalized.confidence }, 'router_final_result');
  if (['system', 'policy'].includes(llmNormalized.intent)) {
    clearConsentState(threadId);
  }
  if (llmNormalized.intent === 'web_search' && !llmNormalized.slots?.search_query) {
    try {
      const q = await optimizeSearchQuery(message, currentSlots, 'web_search', logger?.log);
      if (q && q.trim()) {
        llmNormalized.slots = { ...llmNormalized.slots, search_query: q } as any;
      }
    } catch (error) {
      logger?.log?.debug({ error: String(error) }, 'search_query_optimization_failed');
      llmNormalized.slots = { ...llmNormalized.slots, search_query: message } as any;
    }
  }
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
    
    // Extract slots using our parsers
    const extractedSlots = await extractSlots(message, ctxSlots, log);
    
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
