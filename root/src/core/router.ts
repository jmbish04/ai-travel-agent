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
import { extractSlots, extractFlightSlotsOnce } from './parsers.js';
import { transformersEnabled } from '../config/transformers.js';
import { RE, isDirectFlightHeuristic } from './router.optimizers.js';
import type pino from 'pino';
import { incTurn, incRouterLowConf, noteTurn } from '../util/metrics.js';
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

// AI-first detection functions using existing prompts
async function isPronounFollowup(message: string, log?: pino.Logger): Promise<boolean> {
  // Use consent_detector to identify vague/unclear responses (pronouns typically create unclear responses)
  const consentPrompt = await getPrompt('consent_detector');
  const result = await callLLM(
    consentPrompt + `\n\nUser message: "${message}"`,
    { format: 'text', maxTokens: 5 },
    log
  );
  return result.trim().toLowerCase() === 'unclear';
}

async function isQuickAck(message: string, log?: pino.Logger): Promise<boolean> {
  // Use consent_detector to identify positive acknowledgments
  const consentPrompt = await getPrompt('consent_detector');
  const result = await callLLM(
    consentPrompt + `\n\nUser message: "${message}"`,
    { format: 'text', maxTokens: 5 },
    log
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
  if (await isQuickAck(trimmed, log)) return true;
  return await isPronounFollowup(trimmed, log);
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
  const shouldSkip = await shouldSkipContextDetector(message, params.log);
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

  for (const key of ['destinationCity', 'city', 'originCity'] as const) {
    const value = freshSlots[key];
    if (typeof value === 'string') {
      const fallback = key === 'destinationCity'
        ? fallbackDestination || fallbackCity
        : key === 'originCity'
          ? fallbackOrigin || fallbackDestination || fallbackCity
          : fallbackCity || fallbackDestination || fallbackOrigin;
      const resolved = resolveLocationPlaceholder(value, fallback || previousLocation);
      if (resolved) {
        freshSlots[key] = resolved;
      } else {
        delete freshSlots[key];
      }
    }
  }

  const newLocation = getPrimaryLocation(freshSlots);

  if (previousLocation && newLocation) {
    if (normalizeLocationName(previousLocation) !== normalizeLocationName(newLocation)) {
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
  
  // Get current slots
  const currentSlots = await getThreadSlots(threadId);
  
  // List of keys to remove
  const keysToRemove = [
    // Consent states
    'awaiting_deep_research_consent',
    'pending_deep_research_query', 
    'awaiting_web_search_consent',
    'pending_web_search_query',
    'awaiting_search_consent',
    'pending_search_query',
    'deep_research_consent_needed',
    
    // Travel data that can conflict between queries
    'originCity',
    'destinationCity', 
    'city',
    'departureDate',
    'returnDate',
    'dates',
    'month',
    'passengers',
    'cabinClass',
    'travelerProfile',
    'complexity_score',
    'complexity_reasoning',
    
    // Flight-specific slots
    'flight_clarification_needed',
    'ambiguity_reason',
    'clarification_options',
    'awaiting_flight_clarification',
    'pending_flight_query',
    'clarification_reasoning'
  ];
  
  // Create new slots object without the keys to remove
  const cleanedSlots: Record<string, string> = {};
  for (const [key, value] of Object.entries(currentSlots)) {
    if (!keysToRemove.includes(key)) {
      cleanedSlots[key] = value;
    }
  }
  
  // Clear all slots and set only the cleaned ones
  await clearThreadSlots(threadId);
  if (Object.keys(cleanedSlots).length > 0) {
    await updateThreadSlots(threadId, cleanedSlots, []);
  }
}

export async function routeIntent({ message, threadId, logger }: {
  message: string; 
  threadId?: string; 
  logger?: {log: pino.Logger}
}): Promise<RouterResultT> {
  logger?.log?.debug({ message }, 'router_start');
  const m = message.trim();

  // 0) Guards (no LLM) - clear consent state for unrelated queries
  if (!m) return RouterResult.parse({ intent:'unknown', needExternal:false, slots:{}, confidence:0.1 });
  
  // Handle flight clarification responses (no recursion)
  let ctxSlots = threadId ? await await getThreadSlots(threadId) : {};
  
  // Clear old context for completely new, unrelated queries
  if (threadId && ctxSlots.awaiting_deep_research_consent === 'true') {
    // Check if this is a completely different query (not a consent response)
    const consentVerdict = await classifyConsentResponse(m, logger?.log);
    if (consentVerdict === 'unclear') {
      await clearConsentState(threadId);
      // Reload slots after clearing
      ctxSlots = await getThreadSlots(threadId);
    }
  }
  
  if (ctxSlots.awaiting_flight_clarification === 'true' && threadId) {
    const userResponse = m.toLowerCase();
    const pendingQuery = ctxSlots.pending_flight_query || '';
    
    // Clear the clarification state
    await updateThreadSlots(threadId, {}, [], [
      'awaiting_flight_clarification',
      'pending_flight_query',
      'clarification_reasoning'
    ]);
    
    // Route based on user's choice (no recursion)
    if (userResponse.includes('direct') || userResponse.includes('search') || userResponse.includes('booking')) {
      const flightSlots = await extractFlightSlotsOnce(pendingQuery, ctxSlots, logger?.log);
      logger?.log?.debug({ choice: 'direct_search', slots: flightSlots }, 'flight_clarification_resolved');
      return RouterResult.parse({
        intent: 'flights',
        needExternal: true,
        slots: { ...ctxSlots, ...flightSlots },
        confidence: 0.9
      });
    } else if (userResponse.includes('research') || userResponse.includes('planning') || userResponse.includes('advice')) {
      logger?.log?.debug({ choice: 'web_research' }, 'flight_clarification_resolved');
      return RouterResult.parse({
        intent: 'web_search',
        needExternal: true,
        slots: { ...ctxSlots, search_query: pendingQuery },
        confidence: 0.9
      });
    } else {
      // Process current message instead of recursion
      logger?.log?.debug({ choice: 'process_current' }, 'flight_clarification_ambiguous');
    }
  }

  // 1) Flight fast-path (no LLM)
  if (RE.flights.test(m)) {
    const { isDirect } = isDirectFlightHeuristic(m);
    if (isDirect) {
      await clearConsentState(threadId); // Clear any pending consent for unrelated queries
      const slots = await extractFlightSlotsOnce(m, ctxSlots, logger?.log);
      logger?.log?.debug({ isDirect:true, slots }, '✈️ FLIGHTS: direct (heuristic_llm_unified)');
      const result = RouterResult.parse({ intent:'flights', needExternal:true, slots, confidence:0.9 });
      // metrics
      incTurn(result.intent);
      if (threadId) noteTurn(threadId, result.intent);
      return result;
    }
  }

  // 2) Deep-research consent? (no LLM)
  if (process.env.DEEP_RESEARCH_ENABLED === 'true') {
    const assessment = await assessQueryComplexity(m, logger?.log);
    if (assessment.isComplex && assessment.confidence >= 0.75) {
      // Clear stale slots when processing a new complex query
      await clearConsentState(threadId);
      const complexityScore = assessment.confidence.toFixed(2);
      threadId && await updateThreadSlots(threadId, {
        awaiting_deep_research_consent:'true',
        pending_deep_research_query:m,
        complexity_reasoning:assessment.reasoning,
        complexity_score:complexityScore
      }, []);
      logger?.log?.debug({ assessment }, 'complexity_consent_gate');
      return RouterResult.parse({
        intent:'system', needExternal:false,
        slots:{
          deep_research_consent_needed:'true',
          complexity_score:complexityScore
        },
        confidence:0.9
      });
    }
  }

  // 3) Transformers-first (no LLM inside)
  let tfm: RouterResultT | undefined = undefined;
  if (transformersEnabled()) tfm = await routeViaTransformersFirst(m, threadId, logger);
  if (tfm) {
    // Intent-gated slot refine (single pass)
    if (tfm.intent === 'flights') {
      const refined = await extractSlots(m, ctxSlots, logger?.log);
      return RouterResult.parse({ ...tfm, slots: { ...tfm.slots, ...refined } });
    }
    const r = RouterResult.parse(tfm);
    incTurn(r.intent);
    if (r.confidence < 0.6) incRouterLowConf(r.intent);
    if (threadId) noteTurn(threadId, r.intent);
    return r;
  }

  // 4) Single LLM call (router_llm) → intent + slots at once
  const prompt = (await getPrompt('router_llm')).replace('{message}', m).replace('{instructions}','');
  const raw = await callLLM(prompt, { responseFormat:'json', log:logger?.log });
  const json = JSON.parse(raw);
  const llm = RouterResult.parse(json);

  if (threadId) {
    const resetResult = await maybeResetContextForMessage({
      threadId,
      message: m,
      slots: ctxSlots,
      newSlots: llm.slots,
      logger: logger?.log,
    });
    ctxSlots = resetResult.slots;
  }

  // Normalize slots to handle null values from LLM
  const normalizedSlots = normalizeSlots(ctxSlots, llm.slots, llm.intent);
  const llmNormalized = { ...llm, slots: normalizedSlots };

  // 5) Post-LLM slot enhancement for flights
  if (llmNormalized.intent === 'flights') {
    try {
      const enhancedSlots = await extractFlightSlotsOnce(m, ctxSlots, logger?.log);
      
      // Preserve relative dates from LLM (today, tomorrow, etc.) over enhanced parsing
      const preservedSlots = { ...enhancedSlots };
      // Use semantic temporal reference detection from slot_memory
      if (llmNormalized.slots?.dates && isTemporalReference(llmNormalized.slots.dates)) {
        preservedSlots.dates = llmNormalized.slots.dates;
        preservedSlots.departureDate = llmNormalized.slots.dates;
        // Don't override month for relative dates
        delete preservedSlots.month;
      }
      
      // Merge LLM slots with enhanced slots, prioritizing preserved relative dates
      const mergedSlots = { ...enhancedSlots, ...llmNormalized.slots, ...preservedSlots };
      
      logger?.log?.debug({ 
        llmSlots: llmNormalized.slots, 
        enhancedSlots, 
        preservedSlots,
        mergedSlots 
      }, 'flights_slot_enhancement');
      
      const enhanced = RouterResult.parse({
        ...llmNormalized,
        slots: mergedSlots
      });
      
      logger?.log?.debug({ intent: enhanced.intent, confidence: enhanced.confidence }, 'router_final_result');
      return enhanced;
    } catch (error) {
      logger?.log?.debug({ error: String(error) }, 'flights_slot_enhancement_failed');
    }
  }
  
  // 6) Post-LLM heuristics (cheap)
  if (llmNormalized.intent === 'flights' && !RE.dateish.test(m)) {
    logger?.log?.debug({ reason:'missing_date' }, 'flights_missing_date');
  }

  logger?.log?.debug({ intent: llmNormalized.intent, confidence: llmNormalized.confidence }, 'router_final_result');
  if (['system','policy'].includes(llmNormalized.intent)) {
    clearConsentState(threadId);
  }
  if (llmNormalized.intent === 'web_search' && !llmNormalized.slots?.search_query) {
    const q = await optimizeSearchQuery(m, ctxSlots, 'web_search', logger?.log);
    llmNormalized.slots = { ...llmNormalized.slots, search_query: q };
  }
  // metrics
  incTurn(llmNormalized.intent);
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
