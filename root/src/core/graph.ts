/**
 * Optimized Graph Implementation - G-E-R-A Pattern
 * Guard → Extract → Route → Act
 * 
 * Key optimizations:
 * - Single-pass extraction (no duplicate NER/CLS/LLM calls)
 * - Fast-path routing for common cases
 * - Unified consent handling
 * - Decision table for routing logic
 */

import type { Logger } from 'pino';
import pinoLib from 'pino';
import { routeIntent } from './router.js';
import { detectSearchUpgradeRequest } from './search_upgrade.js';

// Declare global process for Node.js environment
declare const process: NodeJS.Process;
import { blendWithFacts } from './blend.js';
import { buildClarifyingQuestion } from './clarifier.js';
import { incClarify } from '../util/metrics.js';
import { 
  getThreadSlots, 
  updateThreadSlots, 
  setLastIntent, 
  getLastIntent,
  normalizeSlots,
  readConsentState,
  writeConsentState,
  getLastReceipts,
  setLastReceipts,
  getLastUserMessage
} from './slot_memory.js';
import { createDecision } from './receipts.js';
import { callLLM, callLLMBatch, optimizeSearchQuery } from './llm.js';
import { getPrompt } from './prompts.js';
import { detectLanguage } from './transformers-detector.js';
import { extractEntitiesEnhanced } from './ner-enhanced.js';
import { searchTravelInfo, getSearchCitation } from '../tools/search.js';
import { summarizeSearch } from './searchSummarizer.js';
import type { SearchResult } from '../tools/search.js';
import {
  buildConstraintGraph,
  getCombinationKey,
  ConstraintType,
} from './constraintGraph.js';
import { classifyConsentResponse } from './consent.js';
import { parseCity } from './parsers.js';

// Types
export type NodeCtx = { msg: string; threadId: string; onStatus?: (status: string) => void };
export type NodeOut =
  | { next: 'weather' | 'destinations' | 'packing' | 'attractions' | 'policy' | 'flights' | 'irrops' | 'unknown' | 'web_search' | 'system'; slots?: Record<string, string> }
  | { done: true; reply: string; citations?: string[] };

type ScoredSpan = { text: string; score: number };
type Entities = {
  locations: ScoredSpan[];
  dates: ScoredSpan[];
  durations: ScoredSpan[];
  money: ScoredSpan[];
};

// Helper functions
function sanitizeSlotsView(all: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(all).filter(([k]) =>
      !k.startsWith('awaiting_') &&
      !k.startsWith('pending_') &&
      k !== 'complexity_reasoning'
    )
  );
}

function sanitizeSearchQuery(input: string): string {
  const stripped = input
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(?:system:|assistant:|user:)\s*/gi, '')
    .replace(/[<>]/g, '')
    .trim();
  return stripped.slice(0, 512);
}

/**
 * Main graph execution with G-E-R-A pattern
 * Reduces complexity and LLM calls through:
 * - Guard stage: Fast micro-rules
 * - Extract stage: Single-pass cached extraction  
 * - Route stage: Decision table
 * - Act stage: Domain nodes
 */
export async function runGraphTurn(
  message: string,
  threadId: string,
  ctx: { log: Logger; onStatus?: (status: string) => void },
): Promise<NodeOut> {
  let llmCallsThisTurn = 0;
  
  // === GUARD STAGE: Fast micro-rules first ===
  const { 
    checkYesNoShortcut,
    buildTurnCache 
  } = await import('./graph.optimizers.js');
  
  // Build turn cache for single-pass extraction
  const C = await buildTurnCache(message, ctx.log);
  
  // Check for YES/NO shortcuts if any consent flags are set
  const earlySlots = await await getThreadSlots(threadId);
  const consentState = readConsentState(earlySlots);
  
  if (consentState.awaiting) {
    const shortcut = checkYesNoShortcut(message);
    const verdict = shortcut ?? await classifyConsentResponse(message, ctx.log);
    if (verdict !== 'unclear') {
      ctx.log.debug({ verdict, fastpath: 'consent' }, 'guard_yes_no_hit');
      await writeConsentState(threadId, { type: '', pending: '' });

      if (verdict === 'yes' && consentState.pending) {
        if (consentState.type === 'deep') {
          return await performDeepResearchNode(consentState.pending, ctx, threadId);
        }
        return await performWebSearchNode(consentState.pending, ctx, threadId);
      }
      return { done: true, reply: 'No problem! Is there something else about travel planning I can help with?' };
    }
  }
  
  // Weather fast-path guard (optional). Disabled by default to avoid extra LLM calls.
  if (process.env.WEATHER_FASTPATH === 'on') {
    if (/\bweather\b/i.test(message) && (/\btoday\b/i.test(message) || /\bthere\b/i.test(message))) {
      const slots = await getThreadSlots(threadId);
      const context = { city: slots.city || slots.destinationCity || slots.originCity || '' };
      try {
        const tpl = await getPrompt('city_parser');
        const prompt = tpl.replace('{message}', message).replace('{context_city}', context.city ?? '');
        const cityResult = await callLLM(prompt, { responseFormat: 'json', log: ctx.log });
        const parsed = JSON.parse(cityResult);
        if (parsed.confidence >= 0.6 && parsed.city) {
          ctx.log.debug({ city: parsed.city, confidence: parsed.confidence, fastpath: 'weather_guard' }, 'guard_weather_hit');
          return await weatherNode(
            { msg: message, threadId, onStatus: ctx.onStatus },
            { city: parsed.city },
            ctx
          );
        }
      } catch (error) {
        ctx.log.debug({ error: String(error) }, 'weather_guard_llm_failed');
      }
    }
  }
  
  // === EXTRACT STAGE: Router-once with intent-gated extractors ===
  // Check for search upgrade request BEFORE routing
  const prevSlots = await getThreadSlots(threadId);
  const previousQuery = prevSlots.last_search_query;
  const { reply: previousAnswer } = await getLastReceipts(threadId);
  
  ctx.log.debug({ message, previousQuery, hasQuery: !!previousQuery }, 'search_upgrade_check');
  
  if (previousQuery) {
    const upgradeResult = await detectSearchUpgradeRequest({
      message,
      previousQuery,
      previousAnswer,
      log: ctx.log
    });
    
    ctx.log.debug({ upgradeResult, previousQuery }, 'search_upgrade_result');
    
    if (upgradeResult.upgrade && upgradeResult.confidence > 0.6) {
      ctx.log.debug({ upgradeResult, previousQuery }, 'search_upgrade_detected');
      // Deepen the user's current topic using their latest message + context,
      // not the stale previousQuery, to avoid losing intent like "hotels".
      const slotCtx = await getThreadSlots(threadId);
      const optimizedCurrent = await optimizeSearchQuery(message, slotCtx, 'web_search', ctx.log);
      // Persist the optimized query for continuity across turns
      await updateThreadSlots(threadId, { last_search_query: optimizedCurrent }, []);
      return await performDeepResearchNode(optimizedCurrent, ctx, threadId);
    }
  }
  
  // Single router call with slots. If guard forced an intent, skip LLM router.
  if (!C.route) {
    if (C.forced) {
      C.route = { intent: C.forced, slots: {}, confidence: 0.9 } as any;
      ctx.log.debug({ route: C.route }, 'router_skipped_forced_intent');
    } else {
      
      if (!C.route) {
        const routed = await routeIntent({
          message,
          threadId: threadId, 
          logger: { log: ctx.log }
        });
        // Filter out null values from slots
        const filteredSlots: Record<string, string> = {};
        for (const [key, value] of Object.entries(routed.slots || {})) {
          if (typeof value === 'string') {
            filteredSlots[key] = value;
          }
        }
        
        C.route = { 
          intent: routed.intent, 
          slots: filteredSlots, 
          confidence: routed.confidence 
        };
        llmCallsThisTurn++;
        ctx.log.debug({ route: C.route }, 'router_once');
      }
    }
  }
  
  // Intent-gated extractors
  const routedIntent = C.forced ?? C.route?.intent;
  const promises = [];
  
  // NER extraction removed - using LLM-first approach instead
  // Only run enhanced slot extraction for flights intent when needed
  
  // Lightweight city extraction for weather/attractions/packing/destinations
  if (routedIntent && ['weather', 'attractions', 'packing', 'destinations'].includes(routedIntent) && !C.route?.slots.city) {
    promises.push((async () => {
      const cityResult = await parseCity(message, C.route?.slots ?? {}, ctx.log).catch(() => ({ success: false } as const));
      if (cityResult?.success && cityResult.data?.normalized && C.route) {
        C.route.slots.city = cityResult.data.normalized;
      }
    })());
  }
  
  // Content classification only for non-weather intents
  if (routedIntent !== 'weather' && !C.clsContent) {
    promises.push((async () => {
      const { transformersEnabled } = await import('../config/transformers.js');
      if (!transformersEnabled()) {
        C.clsContent = { content_type: 'travel', confidence: 0.5 };
        return;
      }
      const { classifyContent: classifyContentTransformers } = await import('./transformers-classifier.js');
      const result = await classifyContentTransformers(message, ctx.log);
      C.clsContent = { 
        content_type: result.content_type || 'travel', 
        confidence: result.confidence || 0.5 
      };
      llmCallsThisTurn++;
    })());
  }
  
  await Promise.all(promises);
  
  // === FAST PATH: Weather with high confidence ===
  const { maybeFastWeather } = await import('./graph.optimizers.js');
  const fastWeather = await maybeFastWeather({
    C, 
    slots: await getThreadSlots(threadId), 
    threadId, 
    log: ctx.log
  });
  
  if (fastWeather && 'next' in fastWeather) {
    ctx.log.debug({ fastpath: 'weather', llmCallsThisTurn }, 'fastpath_hit');
    await updateThreadSlots(threadId, fastWeather.slots || {}, []);
    return await weatherNode(
      { msg: message, threadId, onStatus: ctx.onStatus },
      fastWeather.slots || {},
      ctx
    );
  }
  
  // === UNIFIED CONSENT HANDLING ===
  // Skip consent handling if this is handled by guards (policy, system, etc.)
  const isGuardHandled = ['system', 'policy', 'web_search'].includes(C.route?.intent ?? '');

  if (!isGuardHandled) {
    const currentSlots = await getThreadSlots(threadId);
    const currentConsentState = readConsentState(currentSlots);
    
    if (currentConsentState.awaiting && currentConsentState.pending) {
      const shortcut = checkYesNoShortcut(message);
      const consent = shortcut ?? await classifyConsentResponse(message, ctx.log);
      if (!shortcut && consent !== 'unclear') {
        llmCallsThisTurn++;
      }

      if (consent !== 'unclear') {
        await writeConsentState(threadId, { type: '', pending: '' });

        if (consent === 'yes') {
          if (currentConsentState.type === 'deep') {
            return await performDeepResearchNode(currentConsentState.pending, ctx, threadId);
          }
          return await performWebSearchNode(currentConsentState.pending, ctx, threadId);
        }
        return { done: true, reply: 'No problem! Is there something else about travel planning I can help with?' };
      }
    }
  }
  
  // === ROUTE STAGE: Use cached router result ===
  // Check for unrelated content
  if (C.clsContent?.content_type === 'unrelated') {
    return {
      done: true,
      reply: 'I focus on travel planning. Is there something about weather, destinations, packing, or attractions I can help with?',
    };
  }
  
  // Use cached router result instead of calling routeIntentNode
  let intent = C.forced ?? C.route?.intent;
  
  // === SLOT PROCESSING ===
  const prior = await getThreadSlots(threadId);
  const extractedSlots = C.route?.slots || {};
  const slots = normalizeSlots(prior, extractedSlots, intent);
  
  // Check for missing required slots
  const missing = intent ? checkMissingSlots(intent, slots, message) : [];
  if (missing.length > 0) {
    await updateThreadSlots(threadId, slots, missing, [], intent);
    try { if (intent && missing[0]) incClarify(intent, missing[0]); } catch {}
    const q = await buildClarifyingQuestion(missing, slots, ctx.log);
    return { done: true, reply: q };
  }
  // Clarification resolved: if we previously had awaiting_* flags and now no missing slots
  const hadAwaiting = Object.keys(prior || {}).some((k) => k.startsWith('awaiting_') && (prior as any)[k]);
  if (hadAwaiting && intent) {
    try {
      const { incClarifyResolved } = await import('../util/metrics.js');
      incClarifyResolved(intent);
    } catch {}
  }

  // Update slots and set intent
  await updateThreadSlots(threadId, slots, [], [], intent);
  await setLastIntent(threadId, intent as any);
  
  // Log metrics
  ctx.log.debug({ 
    intent, 
    llmCallsThisTurn, 
    slotsCount: Object.keys(slots).length 
  }, 'graph_turn_complete');
  
  // === ACT STAGE: Route to domain nodes ===
  const routeCtx: NodeCtx = { msg: message, threadId, onStatus: ctx.onStatus };
  return intent ? await routeToDomainNode(intent, routeCtx, slots, ctx) : { done: true, reply: "Unable to determine intent", citations: [] };
}

// === HELPER FUNCTIONS ===

function checkMissingSlots(intent: string, slots: Record<string, string>, message: string): string[] {
  const missing: string[] = [];
  
  const needsLocation = ['attractions', 'packing', 'destinations', 'weather', 'flights']
    .includes(intent);
  const hasOrigin = !!slots.originCity?.trim();
  const hasDestination = !!(slots.destinationCity?.trim() || slots.city?.trim());
  const hasLocation = intent === 'flights'
    ? hasOrigin && hasDestination
    : intent === 'destinations'
      ? !!(slots.city?.trim() || slots.originCity?.trim() || slots.region?.trim())
      : !!slots.city?.trim();
  
  const hasWhen = !!(slots.dates?.trim() || slots.month?.trim());
  const hasImmediateContext = /\b(today|now|currently|right now)\b/i.test(message);
  const hasSpecialContext = /\b(kids?|children|family|business|work|summer|winter|spring|fall)\b/i.test(message);
  
  if (intent === 'flights') {
    if (!hasOrigin && !hasDestination) {
      missing.push('city');
    } else {
      if (!hasOrigin) missing.push('origin');
      if (!hasDestination) missing.push('destination');
    }
  } else if (needsLocation && !hasLocation) {
    missing.push('location');
  }
  if (intent === 'packing' && !hasWhen && !hasImmediateContext && !hasSpecialContext) missing.push('dates');
  
  return missing;
}

async function routeIntentNode(ctx: NodeCtx, logger?: { log: Logger }): Promise<NodeOut> {
  const r = await routeIntent({ message: ctx.msg, threadId: ctx.threadId, logger });
  
  // Filter out null values from slots
  const filteredSlots: Record<string, string> = {};
  for (const [key, value] of Object.entries(r.slots || {})) {
    if (typeof value === 'string') {
      filteredSlots[key] = value;
    }
  }
  
  return { next: r.intent, slots: filteredSlots };
}

async function routeToDomainNode(
  intent: string,
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  const mergedSlots = slots;
  
  switch (intent) {
    case 'destinations':
      return destinationsNode(ctx, mergedSlots, logger);
    case 'weather':
      return weatherNode(ctx, mergedSlots, logger);
    case 'packing':
      return packingNode(ctx, mergedSlots, logger);
    case 'attractions':
      return attractionsNode(ctx, mergedSlots, logger);
    case 'flights':
      return flightsNode(ctx, mergedSlots, logger);
    case 'irrops':
      return irropsNode(ctx, mergedSlots, logger);
    case 'policy':
      return policyNode(ctx, mergedSlots, logger);
    case 'system':
      return systemNode(ctx);
    case 'web_search':
      return webSearchNode(ctx, mergedSlots, logger);
    case 'unknown':
    default:
      return unknownNode(ctx, logger);
  }
}

// === DOMAIN NODES ===

async function weatherNode(
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  const threadSlots = sanitizeSlotsView(await getThreadSlots(ctx.threadId));
  const mergedSlots = { ...threadSlots, ...slots };
  
  const city = mergedSlots.city;
  if (!city) {
    return { done: true, reply: 'Which city would you like weather information for?' };
  }
  
  // Fallback slot extraction if month/dates not already extracted
  let finalSlots = mergedSlots;
  if (!mergedSlots.month && !mergedSlots.dates) {
    try {
      const { extractSlots } = await import('./parsers.js');
      const lastMessage = await getLastUserMessage(ctx.threadId);
      if (lastMessage) {
        const extractedSlots = await extractSlots(lastMessage, mergedSlots, logger.log);
        finalSlots = { ...mergedSlots, ...extractedSlots };
        console.log(`🌍 WEATHER: Extracted additional slots:`, extractedSlots);
      }
    } catch (error) {
      logger.log?.debug({ error: String(error) }, 'weather_slot_extraction_failed');
    }
  }
  
  try {
    const { getWeather } = await import('../tools/weather.js');
    const result = await getWeather({ 
      city,
      month: finalSlots.month,
      dates: finalSlots.dates,
      datesOrMonth: finalSlots.datesOrMonth
    });
    
    if (result.ok) {
      const normalizedSource = (result.source || 'Open-Meteo').toString();
      const facts = [{ source: normalizedSource, key: 'weather_summary', value: result.summary }];
      const decisions = [createDecision(
        'Used weather API for forecast',
        `Retrieved weather for ${city} using Open-Meteo`,
        ['Skip weather lookup', 'Use web search instead'],
        0.95
      )];
      await setLastReceipts(ctx.threadId, facts, decisions, result.summary);
      logger.log?.debug({ wroteFacts: facts.length, node: 'weather' }, 'receipts_written');
      return { done: true, reply: result.summary, citations: [normalizedSource] };
    } else {
      return { done: true, reply: `Sorry, I couldn't get weather information for ${city}. ${'reason' in result ? result.reason : 'Unknown error'}` };
    }
  } catch (error) {
    logger.log?.warn({ error: String(error), city }, 'weather_fetch_failed');
    return { done: true, reply: `Sorry, I couldn't get weather information for ${city}. Please try another city.` };
  }
}

async function destinationsNode(
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  const threadSlots = sanitizeSlotsView(await getThreadSlots(ctx.threadId));
  const mergedSlots = { ...threadSlots, ...slots };
  
  logger.log?.debug({ 
    threadSlots, 
    inputSlots: slots, 
    mergedSlots, 
    message: ctx.msg 
  }, 'destinations_node_start');

  try {
    logger.log?.debug('destinations_engine_import_start');
    const { DestinationEngine } = await import('../core/destination_engine.js');
    logger.log?.debug('destinations_engine_import_success');
    
    logger.log?.debug({ mergedSlots }, 'destinations_engine_call_start');
    const destinations = await DestinationEngine.getRecommendations(mergedSlots);
    logger.log?.debug({ 
      destinationsCount: destinations.length, 
      destinations: destinations.slice(0, 2) 
    }, 'destinations_engine_call_result');
    
    if (destinations.length > 0) {
      // Use LLM to create a better summary with grouping and interactive suggestions
      const destinationList = destinations.map((d: any) => {
        const capital = d.capital ? d.capital[0] : 'N/A';
        const subregion = d.subregion || d.region;
        const population = d.population ? `${Math.round(d.population / 1000000)}M people` : '';
        return `${d.name.common}, ${capital} (${subregion}${population ? `, ${population}` : ''})`;
      }).join('\n');
      
      // Get the summarizer prompt
      const summarizerPrompt = await getPrompt('destination_summarizer');
      const prompt = summarizerPrompt.replace('{destinations}', destinationList);
      
      // Debug: log the full prompt being sent to LLM
      logger.log?.debug({ 
        promptLength: prompt.length, 
        destinationCount: destinations.length,
        promptPreview: prompt.substring(0, 200) + '...'
      }, 'destination_summarizer_prompt_debug');
      
      // Call LLM for summarization with JSON format
      const summary = await callLLM(prompt, { responseFormat: 'json', log: logger.log });
      
      // Parse and format the JSON response
      let formattedSummary;
      try {
        const parsed = JSON.parse(summary);
        formattedSummary = parsed.regions.map((region: any) => 
          `## ${region.name}\n${region.description}`
        ).join('\n\n') + '\n\n> "' + parsed.interactive_suggestion + '"';
      } catch (e) {
        logger.log?.warn({ error: e, summary }, 'destination_summarizer_json_parse_failed');
        formattedSummary = summary; // fallback to raw response
      }
      
      const reply = "Based on your preferences, here are some recommended destinations:\n\n" + formattedSummary;
      const citations = ['REST Countries API'];
      
      const facts = [{ source: 'REST Countries API', key: 'destinations_list', value: destinationList }];
      const decisions = [createDecision(
        'Recommended destinations from API',
        'User asked for destinations; used REST Countries API',
        ['Skip destinations lookup', 'Use generic guidance'],
        0.9
      )];
      await setLastReceipts(ctx.threadId, facts, decisions, reply);
      logger.log?.debug({ wroteFacts: facts.length, node: 'destinations' }, 'receipts_written');
      
      logger.log?.debug({ reply: reply.slice(0, 100) + '...' }, 'destinations_node_success');
      return { done: true, reply, citations };
    } else {
      logger.log?.debug('destinations_engine_returned_empty');
      writeConsentState(ctx.threadId, { type: 'web_after_rag', pending: ctx.msg });
      return { 
        done: true, 
        reply: `I couldn't find any destinations based on your preferences. Would you like me to search the web for current information? Type 'yes' to proceed with web search, or ask me something else.`,
        citations: ['Internal Knowledge Base (Insufficient Results)']
      };
    }
  } catch (error) {
    logger.log?.error({ 
      error: String(error), 
      stack: error instanceof Error ? error.stack : undefined,
      mergedSlots 
    }, 'destinations_tool_failed');
    writeConsentState(ctx.threadId, { type: 'web_after_rag', pending: ctx.msg });
    return { 
      done: true, 
      reply: `I'm sorry, I'm having trouble searching for destinations right now. Would you like me to search the web for current information? Type 'yes' to proceed with web search, or ask me something else.`,
      citations: ['Internal Knowledge Base (Insufficient Results)']
    };
  }
}

async function packingNode(
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  const threadSlots = sanitizeSlotsView(await getThreadSlots(ctx.threadId));
  const mergedSlots = { ...threadSlots, ...slots };
  
  const { reply, citations } = await blendWithFacts(
    {
      message: ctx.msg,
      route: {
        intent: 'packing',
        needExternal: false,
        slots: mergedSlots,
        confidence: 0.7,
      },
      threadId: ctx.threadId,
    },
    logger || { log: pinoLib({ level: 'silent' }), onStatus: ctx.onStatus },
  );
  return { done: true, reply, citations };
}

async function attractionsNode(
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  const threadSlots = sanitizeSlotsView(await getThreadSlots(ctx.threadId));
  const mergedSlots = { ...threadSlots, ...slots };

  const city = mergedSlots.city;
  if (!city) {
    return { done: true, reply: 'I need to know which city you\'re asking about to find attractions.' };
  }

  // Try attractions tool first
  try {
    const { getAttractions } = await import('../tools/attractions.js');
    const isKidFriendly = /\b(kids?|children|family|kid-friendly|kid friendly|toddler|stroller)\b/i.test(ctx.msg);
    const profile = isKidFriendly ? 'kid_friendly' : 'default';

    const result = await getAttractions({ city, limit: 7, profile });

    if (result.ok) {
      const sourceName = result.source === 'opentripmap' ? 'OpenTripMap' : getSearchCitation();
      const reply = `Here are some attractions in ${city}:\n\n${result.summary}\n\nSource: ${sourceName}`;
      const citations = result.source ? [sourceName] : [];
      
      const facts = [{
        source: sourceName,
        key: 'attractions_summary',
        value: result.summary
      }];
      const decisions = [createDecision(
        'Found attractions using OpenTripMap',
        `Retrieved ${profile === 'kid_friendly' ? 'family-friendly ' : ''}attractions for ${city}`,
        ['Fallback to web search', 'Skip attractions lookup'],
        0.9
      )];
      await setLastReceipts(ctx.threadId, facts, decisions, reply);
      logger.log?.debug({ wroteFacts: facts.length, node: 'attractions' }, 'receipts_written');
      
      return { done: true, reply, citations };
    }
  } catch (error) {
    logger.log?.warn({ error: String(error), city }, 'attractions_tool_failed');
  }
  
  // Fallback to web search
  return webSearchNode(ctx, { ...mergedSlots, search_query: `${city} attractions things to do` }, logger);
}

async function flightsNode(
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  const threadSlots = sanitizeSlotsView(await getThreadSlots(ctx.threadId));
  const mergedSlots = { ...threadSlots, ...slots };
  
  // Clear any previous Amadeus failure flags to allow retry
  if (mergedSlots.amadeus_failed) {
    await updateThreadSlots(ctx.threadId, { amadeus_failed: '' }, []);
  }
  
  // Try Amadeus API first
  try {
    const { searchFlights, convertToAmadeusDate } = await import('../tools/amadeus_flights.js');
    
    let departureDate = mergedSlots.departureDate || mergedSlots.dates;
    const returnDate = mergedSlots.returnDate;
    
    // If no date specified, default to today for current price queries
    if (!departureDate && mergedSlots.originCity && (mergedSlots.destinationCity || mergedSlots.city)) {
      const today = new Date();
      departureDate = today.toISOString().split('T')[0]; // YYYY-MM-DD format
      logger.log?.debug({ defaultDate: departureDate }, 'flights_using_default_date');
    }
    
    if (mergedSlots.originCity && (mergedSlots.destinationCity || mergedSlots.city) && departureDate) {
      const result = await searchFlights({
        origin: mergedSlots.originCity,
        destination: (mergedSlots.destinationCity || mergedSlots.city)!,
        departureDate: await convertToAmadeusDate(departureDate),
        returnDate: returnDate ? returnDate : undefined,
        passengers: mergedSlots.passengers ? parseInt(mergedSlots.passengers) : undefined,
        cabinClass: mergedSlots.cabinClass,
      });

      if (result.ok) {
        const facts = [{
          source: 'Amadeus',
          key: 'flight_offers_summary',
          value: result.summary
        }];
        const decisions = [createDecision(
          'Searched live flight offers (Amadeus)',
          `Queried ${mergedSlots.originCity}→${mergedSlots.destinationCity || mergedSlots.city} for ${departureDate}`,
          ['Fallback to web results', 'Ask for different date'],
          0.9
        )];
        await setLastReceipts(ctx.threadId, facts, decisions, result.summary);
        logger.log?.debug({ wroteFacts: facts.length, node: 'flights' }, 'receipts_written');
        return { 
          done: true, 
          reply: result.summary, 
          citations: ['Amadeus Flight API - Live flight search results']
        };
      } else {
        // Amadeus returned no results or error → fallback to web with notice
        await updateThreadSlots(ctx.threadId, { amadeus_failed: 'true' }, []);
        const converted = departureDate ? await convertToAmadeusDate(departureDate) : '';
        const query = `${mergedSlots.originCity} ${mergedSlots.destinationCity || mergedSlots.city} flights ${converted}`.trim();
        const web = await webSearchNode(ctx, { ...mergedSlots, search_query: query }, logger);
        if ('reply' in web) {
          web.reply = `I couldn't find availability via Amadeus${result && 'reason' in result ? ` (reason: ${result.reason})` : ''}. ` +
                      `Here are results from the web that might help.\n\n${web.reply}`;
        }
        return web;
      }
    }
  } catch (error) {
    logger.log?.warn({ error: String(error) }, 'amadeus_flights_failed');
    // Explicit web search fallback on error for flight flow
    const q = `${mergedSlots.originCity || ''} ${mergedSlots.destinationCity || mergedSlots.city || ''} flights ${mergedSlots.departureDate || mergedSlots.dates || ''}`.trim();
    if (q.replace(/\s+/g, '').length > 0) {
      const web = await webSearchNode(ctx, { ...mergedSlots, search_query: q }, logger);
      if ('reply' in web) {
        web.reply = `Amadeus search errored; showing web results instead.\n\n${web.reply}`;
      }
      return web;
    }
  }
  
  // Fallback to blend with facts (keeps policy/safety consistent). If the user
  // explicitly asked to "search" we can still provide helpful web results.
  if (/\bsearch\b/i.test(ctx.msg) && (mergedSlots.originCity || mergedSlots.destinationCity || mergedSlots.city)) {
    const q = `${mergedSlots.originCity || ''} ${mergedSlots.destinationCity || mergedSlots.city || ''} flights`.trim();
    const web = await webSearchNode(ctx, { ...mergedSlots, search_query: q }, logger);
    if ('reply' in web) {
      web.reply = `I can search the web while we confirm exact dates. ` +
                  `Please share your travel date to check live availability.\n\n${web.reply}`;
    }
    return web;
  }

  // Otherwise blend facts/ask clarifying questions
  const { reply, citations } = await blendWithFacts(
    {
      message: ctx.msg,
      route: {
        intent: 'flights',
        needExternal: true,
        slots: mergedSlots,
        confidence: 0.7,
      },
      threadId: ctx.threadId,
    },
    logger || { log: pinoLib({ level: 'silent' }), onStatus: ctx.onStatus },
  );
  return { done: true, reply, citations };
}

async function irropsNode(
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  const threadSlots = sanitizeSlotsView(await getThreadSlots(ctx.threadId));
  const mergedSlots = { ...threadSlots, ...slots };

  try {
    const { processIrrops } = await import('../core/irrops_engine.js');
    const { parsePNRFromText } = await import('../tools/pnr_parser.js');
    
    logger.onStatus?.('Processing disruption...');
    
    // Parse PNR from message or use mock data for testing
    let pnr = await parsePNRFromText(ctx.msg);
    if (!pnr) {
      // Generate future date for mock PNR
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const futureDateTime = tomorrow.toISOString();
      const arrivalTime = new Date(tomorrow.getTime() + 3 * 60 * 60 * 1000).toISOString(); // +3 hours
      
      // Extract flight number and carrier from slots
      const flightNumber = mergedSlots.flightNumber || 'AA123';
      const carrier = flightNumber.length >= 2 ? flightNumber.substring(0, 2) : 'AA';
      
      // Mock PNR for testing - in production would require actual PNR data
      pnr = {
        recordLocator: mergedSlots.recordLocator || 'ABC123',
        passengers: [{ name: 'PASSENGER', type: 'ADT' }],
        segments: [{
          origin: mergedSlots.originCity || 'JFK',
          destination: mergedSlots.destinationCity || mergedSlots.city || 'LAX',
          departure: futureDateTime,
          arrival: arrivalTime,
          carrier: carrier,
          flightNumber: flightNumber,
          cabin: 'Y',
          status: 'XX' // Cancelled
        }]
      };
    }

    // Classify disruption from message
    const message = ctx.msg.toLowerCase();
    let disruptionType: 'cancellation' | 'delay' | 'equipment_change' | 'user_request' = 'user_request';
    let severity: 'low' | 'medium' | 'high' = 'medium';
    
    if (message.includes('cancel')) {
      disruptionType = 'cancellation';
      severity = 'high';
    } else if (message.includes('delay')) {
      disruptionType = 'delay';
      severity = message.includes('hour') ? 'medium' : 'low';
    } else if (message.includes('equipment') || message.includes('aircraft')) {
      disruptionType = 'equipment_change';
      severity = 'medium';
    }

    const disruption = {
      type: disruptionType,
      severity,
      affectedSegments: [0], // Assume first segment affected
      timestamp: new Date().toISOString(),
      reason: `Disruption detected: ${disruptionType}`
    };

    const preferences = {
      maxPriceIncrease: mergedSlots.maxPriceIncrease ? parseFloat(mergedSlots.maxPriceIncrease) : undefined,
      preferredCarriers: mergedSlots.preferredCarriers?.split(','),
      minConnectionTime: mergedSlots.minConnectionTime ? parseInt(mergedSlots.minConnectionTime) : undefined
    };

    const options = await processIrrops(pnr, disruption, preferences);

    if (!options || options.length === 0) {
      return { done: true, reply: 'I couldn\'t find any suitable rebooking options. Please contact your airline directly or try again with different preferences.' };
    }

    // Format the response
    const optionsText = options.map((option, index) => {
      const priceText = option.priceChange.amount > 0 
        ? `Additional cost: $${option.priceChange.amount} ${option.priceChange.currency}`
        : option.priceChange.amount < 0 
        ? `Refund: $${Math.abs(option.priceChange.amount)} ${option.priceChange.currency}`
        : 'No additional cost';
      
      const routeText = option.segments.map((seg: any) => 
        `${seg.carrier}${seg.flightNumber.replace(seg.carrier, '')} ${seg.origin}-${seg.destination}`
      ).join(', ');

      return `**Option ${index + 1}** (${option.type.replace('_', ' ')}):\n` +
             `Route: ${routeText}\n` +
             `${priceText}\n` +
             `Confidence: ${Math.round(option.confidence * 100)}%\n` +
             `Rules: ${option.rulesApplied.slice(0, 2).join(', ')}`;
    }).join('\n\n');

    const reply = `I found ${options.length} rebooking options for your disruption:\n\n${optionsText}\n\n` +
                  `All options have been validated against airline policies and connection requirements. ` +
                  `Would you like me to proceed with one of these options?`;

    const citations = options.flatMap(opt => opt.citations).slice(0, 3);
    
    // Store receipts for the IRROPS response
    const facts = options.flatMap((opt, i) => [
      ...opt.citations.map((cit, j) => ({
        source: cit,
        key: `irrops_option_${i}_citation_${j}`,
        value: `Alternative flight option ${i + 1}`
      })),
      // Add detailed option data as facts
      {
        source: 'IRROPS Engine',
        key: `irrops_option_${i}_price`,
        value: `Additional cost: $${opt.priceChange.amount} ${opt.priceChange.currency}`
      },
      {
        source: 'IRROPS Engine', 
        key: `irrops_option_${i}_confidence`,
        value: `Confidence: ${Math.round(opt.confidence * 100)}%`
      },
      {
        source: 'IRROPS Engine',
        key: `irrops_option_${i}_rules`,
        value: `Rules: ${opt.rulesApplied.join(', ')}`
      },
      {
        source: 'IRROPS Engine',
        key: `irrops_option_${i}_route`,
        value: `Route: ${opt.segments?.[0]?.flightNumber || 'N/A'} ${opt.segments?.[0]?.origin || 'N/A'}-${opt.segments?.[0]?.destination || 'N/A'}`
      }
    ]);
    const decisions = [createDecision(
      `Processed flight disruption for ${pnr.recordLocator}`,
      `User reported cancellation of flight ${pnr.segments[0]?.carrier}${pnr.segments[0]?.flightNumber} from ${pnr.segments[0]?.origin} to ${pnr.segments[0]?.destination}`,
      ['Skip rebooking', 'Use web search instead'],
      0.9
    )];
    await setLastReceipts(ctx.threadId, facts, decisions, reply);
    
    return { done: true, reply, citations };
    
  } catch (error) {
    logger.log?.warn({ error: String(error) }, 'irrops_processing_failed');
    return { done: true, reply: 'I\'m having trouble processing your disruption request. Please try again or contact your airline directly for assistance.' };
  }
}

async function policyNode(
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  try {
    const { PolicyAgent } = await import('./policy_agent.js');
    const agent = new PolicyAgent();
    
    // Check if user wants receipts/citations
    const wantReceipts = /receipt|citation|proof|evidence|source/i.test(ctx.msg);
    
    const { answer, citations, receipts, needsWebSearch, assessmentReason } = await agent.answer(ctx.msg, undefined, ctx.threadId, logger.log, wantReceipts, slots);
    
    // Check if no results found or quality assessment suggests web search
    const noRelevantInfo = !citations.length || 
                          citations.every(c => !c.snippet?.trim()) ||
                          /do not specify|cannot determine|not found|no information|don't contain/i.test(answer);
    
    // If we have successful receipts, use them even if needsWebSearch is true
    const hasSuccessfulReceipts = receipts && receipts.length > 0 && receipts.some(r => r.confidence >= 0.6);

    // Route to web search if needed (but not if we have good receipts)
    if ((noRelevantInfo || needsWebSearch) && !hasSuccessfulReceipts) {
      // For visa questions, auto-fallback to web search
      if (/\b(visa|passport|entry requirements?|immigration)\b/i.test(ctx.msg)) {
        const webResult = await webSearchNode(ctx, { ...slots, search_query: ctx.msg }, logger);
        if ('reply' in webResult && webResult.reply) {
          webResult.reply = `I don't have this information in our internal database, but let me search the web for current details:\n\n${webResult.reply}`;
        }
        return webResult;
      }
      
      // For other policy questions, ask for consent
      writeConsentState(ctx.threadId, { type: 'web_after_rag', pending: ctx.msg });
      
      const reason = needsWebSearch ? `Quality assessment: ${assessmentReason}` : 'No relevant information found';
      return { 
        done: true, 
        reply: `I couldn't find sufficient information about this in our internal knowledge base (${reason}). Would you like me to search the web for current information? Type 'yes' to proceed with web search, or ask me something else.`,
        citations: ['Internal Knowledge Base (Insufficient Results)']
      };
    }
    
    // Prefer synthesizing from receipts when we have high-confidence browser content
    let finalAnswer = answer;
    let displayCitations: Array<{ url?: string; title?: string; snippet?: string; score?: number }> = citations;
    if (hasSuccessfulReceipts) {
      try {
        const summarizer = await getPrompt('policy_summarizer');
        const ctxText = (receipts || [])
          .map((r, i) => `[${i + 1}] Source: ${r.url}\n${r.quote}`)
          .join('\n\n');
        const prompt = summarizer
          .replace('{question}', ctx.msg)
          .replace('{context}', ctxText);
        const receiptsAnswer = await callLLM(prompt, { log: logger.log });
        const cleaned = receiptsAnswer.trim();
        const looksUseful = cleaned.length > 0 && !/no information available/i.test(cleaned);
        // Override when original looks insufficient or when we have a solid receipts-based answer
        if (looksUseful && (noRelevantInfo || cleaned.length >= Math.min(60, answer.length))) {
          finalAnswer = cleaned;
          displayCitations = (receipts || []).map(r => ({ url: r.url, title: new URL(r.url).hostname + ' policy', snippet: r.quote, score: r.confidence }));
        }
      } catch (e) {
        logger.log?.debug({ error: String(e) }, 'receipt_synthesis_failed_fallback_to_rag_summary');
      }
    }

    // Format answer with sources and receipts
    let formattedAnswer = displayCitations.length > 0 
      ? `${finalAnswer}\n\nSources:\n${displayCitations.map((c, i) => `${i + 1}. ${c.title ?? 'Internal Knowledge Base'}${c.url ? ` — ${c.url}` : ''}`).join('\n')}`
      : finalAnswer;
    
    // Add receipts if available
    if (receipts && receipts.length > 0) {
      const receiptText = receipts.map((r, i) => 
        `${i + 1}. ${r.url} (confidence: ${(r.confidence * 100).toFixed(0)}%)\n   "${r.quote.slice(0, 150)}..."`
      ).join('\n');
      formattedAnswer += `\n\nPolicy Receipts:\n${receiptText}`;
    }
    
    // Store facts for /why command
    const { setLastReceipts } = await import('./slot_memory.js');
    const { createDecision } = await import('./receipts.js');
    const facts = displayCitations.map((c, i) => ({
      key: `policy_citation_${i}`,
      value: c.snippet || c.title || 'Policy information',
      source: c.title || c.url || 'Internal Knowledge Base'
    }));
    const decisions = [createDecision(
      `Retrieved ${displayCitations.length} policy citations`,
      `User requested policy information, found ${displayCitations.length} relevant citations from internal knowledge base`,
      ['Skip policy lookup', 'Use web search instead'],
      0.9
    )];
    setLastReceipts(ctx.threadId, facts, decisions, formattedAnswer);
    
    const citationTitles = displayCitations.map(c => c.title || c.url || 'Internal Knowledge Base');
    return { done: true, reply: formattedAnswer, citations: citationTitles };
    
  } catch (error) {
    logger.log?.warn({ error: String(error), message: ctx.msg }, 'policy_agent_failed');
    return webSearchNode(ctx, slots, logger);
  }
}

async function systemNode(ctx: NodeCtx): Promise<NodeOut> {
  // Check if deep research consent is needed
  const slots = await getThreadSlots(ctx.threadId);
  const consentState = readConsentState(slots);
  
  if (consentState.awaiting && consentState.type === 'deep' && consentState.pending) {
    return {
      done: true,
      reply: 'This looks like a complex travel planning request that would benefit from deeper research. Would you like me to search for comprehensive information to help with your trip planning?'
    };
  }
  
  return {
    done: true,
    reply: 'I\'m an AI travel assistant. I can help you with weather, destinations, packing, and attractions. What would you like to know?',
  };
}

async function webSearchNode(
  ctx: NodeCtx,
  slots: Record<string, string>,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  // Always optimize the current message for web search, don't reuse old search_query
  const searchQuery = sanitizeSearchQuery(ctx.msg);
  const optimizedQuery = await optimizeSearchQuery(searchQuery, slots, 'web_search', logger.log);
  
  return await performWebSearchNode(optimizedQuery, logger, ctx.threadId);
}

async function unknownNode(
  ctx: NodeCtx,
  logger: { log: Logger; onStatus?: (status: string) => void }
): Promise<NodeOut> {
  const { reply, citations } = await blendWithFacts(
    {
      message: ctx.msg,
      route: {
        intent: 'unknown',
        needExternal: false,
        slots: {},
        confidence: 0.3,
      },
      threadId: ctx.threadId,
    },
    logger || { log: pinoLib({ level: 'silent' }), onStatus: ctx.onStatus },
  );
  return { done: true, reply, citations };
}

// === SEARCH NODES ===

async function performWebSearchNode(
  query: string,
  ctx: { log: Logger },
  threadId: string,
): Promise<NodeOut> {
  ctx.log.debug({ query }, 'performing_web_search_node');
  try { const { incFallback } = await import('../util/metrics.js'); incFallback('web'); } catch {}
  
  // Store the search query for potential upgrade requests
  await updateThreadSlots(threadId, { last_search_query: query }, []);
  
  const searchResult = await searchTravelInfo(query, ctx.log);
  
  if (!searchResult.ok) {
    ctx.log.debug({ reason: searchResult.reason }, 'web_search_failed');
    return {
      done: true,
      reply: 'I\'m unable to search the web right now. Could you ask me something about weather, destinations, packing, or attractions instead?',
    };
  }
  
  if (searchResult.results.length === 0) {
    return {
      done: true,
      reply: 'I couldn\'t find relevant information for your search. Could you try rephrasing your question or ask me about weather, destinations, packing, or attractions?',
    };
  }
  
  // Use unified summarizer (LLM optional based on count)
  const useLLM = process.env.SEARCH_SUMMARY !== 'off' && searchResult.results.length >= 3;
  const { reply, citations } = await summarizeSearch(searchResult.results, query, useLLM, { log: ctx.log });
  
  // Store search receipts
  if (threadId) {
    try {
      const { setLastReceipts } = await import('./slot_memory.js');
      const { createDecision } = await import('./receipts.js');
      // Store same number of facts as LLM sees (up to 7) to avoid verification mismatches
      const facts = searchResult.results.slice(0, 7).map(
        (result: SearchResult, index: number) => ({
          source: getSearchCitation(),
          key: `search_result_${index}`,
          value: `${result.title}: ${result.description.slice(0, 100)}...`,
        }),
      );
      const decisions = [createDecision(
        `Performed web search for: "${query}"`,
        `User query required external web search as it couldn't be answered by travel APIs or internal knowledge`,
        ['Use travel APIs only', 'Skip search'],
        0.85
      )];
      await setLastReceipts(threadId, facts, decisions, reply);
    } catch {
      // ignore receipt storage errors
    }
  }
  
  return {
    done: true,
    reply,
    citations,
  };
}

async function performDeepResearchNode(
  query: string,
  ctx: { log: Logger },
  threadId: string,
): Promise<NodeOut> {
  try {
    // Optimize with full slot context and a neutral web_search intent so
    // location pronouns (e.g., "there") resolve to the active city.
    const slotCtx = await getThreadSlots(threadId);
    const optimizedQuery = await optimizeSearchQuery(query, slotCtx, 'web_search', ctx.log);
    // Persist the optimized query so subsequent upgrades keep continuity.
    await updateThreadSlots(threadId, { last_search_query: optimizedQuery }, []);
    
    const { performDeepResearch } = await import('./deep_research.js');
    const research = await performDeepResearch(optimizedQuery, { threadId }, ctx.log);
    
    // Store receipts
    try {
      const { setLastReceipts } = await import('./slot_memory.js');
      const { createDecision } = await import('./receipts.js');
      const facts = research.citations.map((c, i) => ({ source: c.source, key: `deep_${i}`, value: c.url }));
      const decisions = [createDecision(
        `Deep research performed for: "${query}"`,
        `User requested comprehensive travel information with specific constraints (family, budget, time), so performed deep web research across multiple sources to gather diverse options`,
        ['Basic search only', 'Use travel APIs only'],
        0.9
      )];
      await setLastReceipts(threadId, facts, decisions, research.summary);
    } catch {}
    
    return { done: true, reply: research.summary, citations: research.sources };
  } catch (error) {
    ctx.log.error({ error: error instanceof Error ? error.message : String(error) }, 'deep_research_failed');
    return { done: true, reply: 'I ran into an issue while doing deep research. I can try a standard search instead if you like.' };
  }
}

async function summarizeSearchResults(
  results: Array<{ title: string; url: string; description: string }>,
  query: string,
  ctx: { log: Logger },
): Promise<{ reply: string; citations: string[] }> {
  // Feature flag check
  if (process.env.SEARCH_SUMMARY === 'off') {
    return formatSearchResultsFallback(results);
  }

  try {
    const promptTemplate = await getPrompt('search_summarize');
    const topResults = results.slice(0, 7);

    // Format results for LLM
    const formattedResults = topResults.map((result, index) => ({
      id: index + 1,
      title: result.title.replace(/<[^>]*>/g, ''), // Strip HTML
      url: result.url,
      description: result.description.replace(/<[^>]*>/g, '').slice(0, 200)
    }));
    
    const prompt = promptTemplate
      .replace('{query}', query)
      .replace('{results}', JSON.stringify(formattedResults, null, 2));
    
    const response = await callLLM(prompt, { log: ctx.log });
    
    // Sanitize and validate response
    let sanitized = response
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    
    // Ensure no CoT leakage
    sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');
    
    // Truncate if too long
    if (sanitized.length > 2000) {
      const sentences = sanitized.split(/[.!?]+/);
      let truncated = '';
      for (const sentence of sentences) {
        if ((truncated + sentence).length > 1900) break;
        truncated += sentence + '.';
      }
      sanitized = truncated;
    }
    
    // Ensure Sources block present
    const hasLinks = /https?:\/\//i.test(sanitized) || /Sources:/i.test(sanitized);
    let finalText = sanitized;
    if (!hasLinks) {
      const sourcesBlock = ['Sources:', ...formattedResults.slice(0, 5).map(r => `${r.id}. ${r.title} - ${r.url}`)].join('\n');
      finalText = `${sanitized}\n\n${sourcesBlock}`;
    }
    
    return {
      reply: finalText,
      citations: [getSearchCitation()]
    };
  } catch (error) {
    ctx.log.debug('Search summarization failed, using fallback');
    return formatSearchResultsFallback(results);
  }
}

function formatSearchResultsFallback(
  results: Array<{ title: string; url: string; description: string }>
): { reply: string; citations: string[] } {
  const topResults = results.slice(0, 3);
  const formattedResults = topResults.map(result => {
    const cleanTitle = result.title.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '');
    const cleanDesc = result.description.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '');
    const truncatedDesc = cleanDesc.slice(0, 100) + (cleanDesc.length > 100 ? '...' : '');
    return `• ${cleanTitle} - ${truncatedDesc}`;
  }).join('\n');
  
  return {
    reply: `Based on web search results:\n\n${formattedResults}\n\nSources: ${getSearchCitation()}`,
    citations: [getSearchCitation()]
  };
}
