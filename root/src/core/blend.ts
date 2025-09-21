import type pino from 'pino';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ChatInputT, ChatOutput } from '../schemas/chat.js';
import { getThreadId, pushMessage, getContext } from './memory.js';
import { runGraphTurn } from './graph.js';
import { callLLM, callLLMBatch, optimizeSearchQuery } from './llm.js';
import { classifyContentLLM } from './nlp.js';
import { getPrompt } from './prompts.js';
import { getWeather } from '../tools/weather.js';
import { getCountryFacts } from '../tools/country.js';
import { getAttractions } from '../tools/attractions.js';
import {
  searchTravelInfo,
  getSearchCitation,
  getSearchSource,
} from '../tools/search.js';
import type { SearchResult } from '../tools/search.js';
import { validateNoCitation } from './citations.js';
import type { Fact } from './receipts.js';

// Semantic complexity detection
function isComplexRequest(query: string): boolean {
  const complexTerms = new Set([
    'detailed', 'comprehensive', 'in-depth', 'analysis', 'research', 'study',
    'budget plan', 'itinerary', 'guide'
  ]);
  const lower = query.toLowerCase();
  return Array.from(complexTerms).some(term => lower.includes(term));
}

// Temporal context detection
function hasTemporalContext(message: string): boolean {
  const temporal = new Set(['today', 'now', 'currently', 'right now', 'what to wear']);
  const lower = message.toLowerCase();
  return Array.from(temporal).some(term => lower.includes(term));
}

// Travel context detection
function hasTravelContext(message: string): boolean {
  const contexts = new Set(['kids', 'children', 'family', 'business', 'work', 'summer', 'winter', 'spring', 'fall']);
  const lower = message.toLowerCase();
  return Array.from(contexts).some(term => lower.includes(term));
}
import { getLastReceipts, setLastReceipts, updateThreadSlots, setLastUserMessage, getLastVerification, setLastVerification, getLastIntent, getThreadSlots } from './slot_memory.js';
import { buildReceiptsSkeleton, ReceiptsSchema, Decision, createDecision } from './receipts.js';
import { verifyAnswer } from './verify.js';
import { planBlend, type BlendPlan } from './blend.planner.js';
import { summarizeSearch } from './searchSummarizer.js';
import { composeWeatherReply, composePackingReply, composeAttractionsReply } from './composers.js';
import { incAnswersWithCitations, incFallback, incGeneratedAnswer, incMessages, startSession, resolveSession } from '../util/metrics.js';

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
  
  const sourcesBlock = topResults.map((result, index) => 
    `${index + 1}. ${result.title.replace(/<[^>]*>/g, '')} - ${result.url}`
  ).join('\n');
  
  return {
    reply: `Based on web search results:\n\n${formattedResults}\n\nSources:\n${sourcesBlock}`,
    citations: [getSearchCitation()]
  };
}
async function performWebSearch(
  query: string,
  ctx: { log: pino.Logger; onStatus?: (status: string) => void },
  threadId?: string,
  plan?: BlendPlan,
): Promise<{ reply: string; citations?: string[] }> {
  ctx.log.debug({ query }, 'performing_web_search');
  try { incFallback('web'); } catch {}
  // Opt-in deep research path
  if (process.env.DEEP_RESEARCH_ENABLED === 'true') {
    try {
      const { performDeepResearch } = await import('./deep_research.js');
      const research = await performDeepResearch(query, { threadId }, ctx.log);
      // Verify answer using existing verifier
      try {
        const facts = research.citations.map((c, i) => ({ source: c.source, key: `deep_${i}`, value: c.url }));
        const audit = await verifyAnswer({ reply: research.summary, facts, log: ctx.log });
        if (audit.verdict === 'fail' && audit.revisedAnswer) {
          return { reply: audit.revisedAnswer, citations: research.citations.map((c) => c.source) };
        }
      } catch {}
      return { reply: research.summary, citations: research.citations.map((c) => c.source) };
    } catch (e) {
      ctx.log.warn({ e: e instanceof Error ? e.message : String(e) }, 'deep_research_failed_fallback_single_search');
    }
  }
  
  // Determine if this needs Crawlee deep research
  const isComplexQuery = query.length > 50 || isComplexRequest(query);
  
  ctx.log.debug({ query, isComplexQuery, queryLength: query.length }, 'complex_query_detection');
  
  ctx.onStatus?.('Searching the web...');
  
  const searchResult = await searchTravelInfo(query, ctx.log, isComplexQuery);
  
  if (!searchResult.ok) {
    ctx.log.debug({ reason: searchResult.reason }, 'web_search_failed');
    return {
      reply: 'I\'m unable to search the web right now. Could you ask me something about weather, destinations, packing, or attractions instead?',
      citations: undefined,
    };
  }
  
  if (searchResult.results.length === 0) {
    return {
      reply: 'I couldn\'t find relevant information for your search. Could you try rephrasing your question or ask me about weather, destinations, packing, or attractions?',
      citations: undefined,
    };
  }
  
  // Use deep research summary if available, otherwise regular summarization
  let reply: string;
  let citations: string[];
  
  if (searchResult.deepSummary) {
    reply = searchResult.deepSummary;
    citations = [`${getSearchCitation()} + Deep Research`];
    ctx.log.debug('using_crawlee_deep_research_summary');
  } else {
    const useLLM = plan?.summarize_web_with_llm ?? (searchResult.results.length >= 3);
    const result = await summarizeSearch(searchResult.results, query, useLLM, ctx);
    reply = result.reply;
    citations = result.citations || [getSearchCitation()];
  }
  
  // Store search facts for receipts
  if (threadId) {
    try {
      const facts: Fact[] = searchResult.results.slice(0, 3).map(
        (result: SearchResult, index: number) => ({
          source: getSearchCitation(),
          key: `search_result_${index}`,
          value: `${result.title}: ${result.description}`,
        }),
      );
      const decisions = [createDecision(
        'Used web search for travel information',
        'User requested search or question couldn\'t be answered by travel APIs, so performed web search to find relevant information',
        ['Use travel APIs only', 'Skip search'],
        0.8
      )];
      await setLastReceipts(threadId, facts, decisions, reply);
    } catch {
      // ignore
    }
  }
  
  // Metrics instrumentation
  incGeneratedAnswer();
  if (citations.length > 0) {
    incAnswersWithCitations();
    try { (await import('../util/metrics.js')).incAnswerUsingExternal(); } catch {}
  }
  
  return { reply, citations };
}

export async function handleChat(
  input: ChatInputT,
  ctx: { log: pino.Logger; onStatus?: (status: string) => void },
) {
  // Metrics: count every message
  incMessages();
  
  // Early handling for empty/emoji-only or non-informative inputs
  const raw = input.message || '';
  const trimmed = raw.trim();
  const emojiOnly = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(raw);
  const nonAlphaNum = !/[a-zA-Z0-9]/.test(raw);
  if (trimmed.length === 0 || emojiOnly || (raw.length <= 6 && nonAlphaNum)) {
    const reply = "I'm a travel assistant. Please share a travel question (weather, destinations, packing, or attractions).";
    const threadId = getThreadId(input.threadId);
    return ChatOutput.parse({ reply, threadId });
  }
  
  ctx.onStatus?.('Analyzing your request...');
  
  const threadId = getThreadId(input.threadId);
  
  // Start session tracking
  startSession(threadId);
  
  const wantReceipts = Boolean((input as { receipts?: boolean }).receipts) ||
    /^\s*\/why\b/i.test(input.message);
  if (wantReceipts) {
    await setLastUserMessage(threadId, input.message);
    const stored = await getLastReceipts(threadId) || {};
    const facts = stored.facts || [];
    const decisions = stored.decisions || [];
    let reply = stored.reply || 'No previous answer to explain.';
    const token_estimate = 400;
    const receipts = buildReceiptsSkeleton(facts as Fact[], decisions, token_estimate);
    try {
      const autoVerify = process.env.AUTO_VERIFY_REPLIES === 'true';
      let audit: Awaited<ReturnType<typeof verifyAnswer>> | undefined;
      if (autoVerify) {
        const last = await getLastVerification(threadId);
        if (last) {
          // Map stored artifact to VerifyResult shape (scores optional)
          audit = {
            verdict: last.verdict,
            notes: last.notes || [],
            scores: last.scores,
            revisedAnswer: last.revisedAnswer,
          } as any;
        }
      }
      if (!audit) {
        audit = await verifyAnswer({
          reply,
          facts: (facts as Fact[]).map((f) => ({ key: f.key, value: f.value, source: String(f.source) })),
          log: ctx.log,
          latestUser: await (async () => (await import('./slot_memory.js')).getLastUserMessage(threadId))(),
          previousUsers: await (async () => {
            const msgs = await getContext(threadId);
            const users = msgs.filter(m => m.role === 'user').map(m => m.content);
            // exclude the very last if equal to latest
            const last = users[users.length - 1];
            const trimmed = (await (async () => (await import('./slot_memory.js')).getLastUserMessage(threadId))()) || '';
            const filtered = users.filter(u => u !== trimmed);
            return filtered.slice(-2);
          })(),
          slotsSummary: await getThreadSlots(threadId),
          lastIntent: await getLastIntent(threadId),
        });
        try {
          if (audit.verdict === 'fail') {
            const { incVerifyFail } = await import('../util/metrics.js');
            incVerifyFail((audit.notes?.[0] || 'fail').toLowerCase());
          } else {
            const { incVerifyPass } = await import('../util/metrics.js');
            incVerifyPass();
          }
        } catch {}
      }
      if (audit.verdict === 'fail' && audit.revisedAnswer) {
        reply = audit.revisedAnswer;
      }
      const merged = { ...receipts, selfCheck: { verdict: audit.verdict, notes: audit.notes, scores: (audit as any).scores } };
      const safe = ReceiptsSchema.parse(merged);
      
      // For /why commands, return only receipts content as reply
      const formatDecision = (d: string | Decision) => {
        if (typeof d === 'string') return d;
        return `${d.action} (rationale: ${d.rationale}${d.alternatives ? `, alternatives: ${d.alternatives.join(', ')}` : ''}${d.confidence ? `, confidence: ${d.confidence}` : ''})`;
      };
      const receiptsReply = `--- RECEIPTS ---\n\nSources: ${receipts.sources.join(', ')}\n\nDecisions: ${decisions.map(formatDecision).join(' ')}\n\nSelf-Check: ${audit.verdict}${audit.notes.length > 0 ? ` (${audit.notes.join(', ')})` : ''}\n\nBudget: ${receipts.budgets.ext_api_latency_ms || 0}ms API, ~${token_estimate} tokens`
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      
      try { incGeneratedAnswer(); } catch {}
      return ChatOutput.parse({ reply: receiptsReply, threadId, sources: receipts.sources, receipts: safe });
    } catch {
      const formatDecision = (d: string | Decision) => {
        if (typeof d === 'string') return d;
        return `${d.action} (rationale: ${d.rationale}${d.alternatives ? `, alternatives: ${d.alternatives.join(', ')}` : ''}${d.confidence ? `, confidence: ${d.confidence}` : ''})`;
      };
      const receiptsReply = `--- RECEIPTS ---\n\nSources: ${receipts.sources.join(', ')}\n\nDecisions: ${decisions.map(formatDecision).join(' ')}\n\nSelf-Check: not available\n\nBudget: ${receipts.budgets.ext_api_latency_ms || 0}ms API, ~${token_estimate} tokens`
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      try { incGeneratedAnswer(); } catch {}
      return ChatOutput.parse({ reply: receiptsReply, threadId, sources: receipts.sources });
    }
  }
  await pushMessage(threadId, { role: 'user', content: input.message });
  await setLastUserMessage(threadId, input.message);
  ctx.onStatus?.('Processing your travel request...');
  const result = await runGraphTurn(input.message, threadId, ctx);
  if ('done' in result) {
    await pushMessage(threadId, { role: 'assistant', content: result.reply });
    try {
      if (result.citations && result.citations.length > 0) {
        incAnswersWithCitations();
        try { (await import('../util/metrics.js')).incAnswerUsingExternal(); } catch {}
      }
    } catch {}
    try { incGeneratedAnswer(); } catch {}

    // Auto-verify every reply when enabled
    const autoVerify = process.env.AUTO_VERIFY_REPLIES === 'true';
    let verifiedReply = result.reply;
    let lastAudit: Awaited<ReturnType<typeof verifyAnswer>> | undefined;
    if (autoVerify) {
      try {
        const receiptsData = await getLastReceipts(threadId) || {};
        let facts = (receiptsData.facts || []) as Fact[];
        
        // Grace wait for flights/destinations if no facts initially
        const intent = await getLastIntent(threadId);
        if (facts.length === 0 && ['flights', 'destinations'].includes(intent || '')) {
          for (let i = 0; i < 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 250));
            const again = await getLastReceipts(threadId);
            if ((again?.facts?.length || 0) > 0) { 
              facts = again.facts as Fact[]; 
              break; 
            }
          }
        }
        
        ctx.log.debug({ factsCount: facts.length, factsSample: facts.slice(0, 2), threadId }, 'auto_verify_facts_loaded');
        const msgs = await getContext(threadId);
        const users = msgs.filter(m => m.role === 'user').map(m => m.content);
        const latestUser = users[users.length - 1] || input.message;
        const previousUsers = users.slice(0, -1).slice(-2);
        const slots = await getThreadSlots(threadId);

        // Fallback: if facts missing but citations exist, synthesize minimal evidence from citations
        if ((!facts || facts.length === 0) && Array.isArray(result.citations) && result.citations.length > 0) {
          facts = result.citations.map((src, i) => ({ source: String(src), key: `citation_${i}`, value: 'source_only' }));
          ctx.log.debug({ synthesizedFacts: facts, citations: result.citations }, 'auto_verify_facts_synthesized');
        }
        
        // Debug: log what reply is being verified
        ctx.log.debug({ 
          replyLength: result.reply.length, 
          replyPreview: result.reply.substring(0, 100) + '...',
          factsCount: facts.length 
        }, 'auto_verify_reply_debug');
        
        // Skip verification for technical commands only (allow IRROPS verification)
        if (input.message.startsWith('/')) {
          ctx.log.debug({ command: input.message }, 'skipping_verification_for_command');
          return ChatOutput.parse({ reply: result.reply, threadId });
        }
        
        lastAudit = await verifyAnswer({
          reply: result.reply,
          facts: facts.map(f => ({ key: f.key, value: f.value, source: String(f.source) })),
          log: ctx.log,
          latestUser,
          previousUsers,
          slotsSummary: slots,
          lastIntent: intent,
        });
        // Metrics
        try {
          const { incVerifyFail, incVerifyPass, observeVerifyScores } = await import('../util/metrics.js');
          if (lastAudit.verdict === 'fail') {
            incVerifyFail((lastAudit.notes?.[0] || 'fail').toLowerCase());
          } else {
            incVerifyPass();
          }
          if ((lastAudit as any).scores) {
            observeVerifyScores((lastAudit as any).scores);
          }
        } catch {}

        // Apply routing on verdict
        if (lastAudit.verdict === 'fail') {
          // Don't rewrite IRROPS responses - they have structured format
          if (input.route.intent === 'irrops') {
            ctx.log.debug({ intent: input.route.intent }, 'preserving_irrops_structured_output');
          } else if (lastAudit.revisedAnswer) {
            verifiedReply = lastAudit.revisedAnswer;
          } else {
            verifiedReply = "I couldn't find sufficiently reliable sources to support this. Would you like me to search the web or clarify details?";
          }
        } else if (lastAudit.verdict === 'warn') {
          const warnInline = (process.env.VERIFY_WARN_INLINE ?? 'true') === 'true';
          if (warnInline) {
            verifiedReply = `${result.reply}\n\nNote: Automated self-check flagged minor uncertainties.`;
          }
        }
        // Persist verification artifact for /why
        await setLastVerification(threadId, {
          verdict: lastAudit.verdict,
          notes: lastAudit.notes || [],
          scores: (lastAudit as any).scores,
          revisedAnswer: lastAudit.revisedAnswer,
          reply: verifiedReply,
        });
      } catch {
        // Swallow verify errors; keep original reply
      }
    }

    // Handle receipts if requested
    const wantReceipts = Boolean((input as { receipts?: boolean }).receipts) ||
      /^\s*\/why\b/i.test(input.message);
    if (wantReceipts) {
      const stored = await getLastReceipts(threadId) || {};
      const facts = stored.facts || [];
      const decisions = stored.decisions || [];
      let reply = verifiedReply;
      const token_estimate = 400;
      const receipts = buildReceiptsSkeleton(facts as Fact[], decisions, token_estimate);
      try {
        const auto = process.env.AUTO_VERIFY_REPLIES === 'true';
        const existing = auto ? await getLastVerification(threadId) : undefined;
        if (existing) {
          const merged = { ...receipts, selfCheck: { verdict: existing.verdict, notes: existing.notes || [], scores: existing.scores } };
          const safe = ReceiptsSchema.parse(merged);
          return ChatOutput.parse({ reply, threadId, sources: receipts.sources, receipts: safe });
        }
        // Fallback: compute verify now
        const audit = await verifyAnswer({
          reply,
          facts: (facts as Fact[]).map((f) => ({ key: f.key, value: f.value, source: String(f.source) })),
          log: ctx.log,
          latestUser: input.message,
          previousUsers: [],
          slotsSummary: await getThreadSlots(threadId),
          lastIntent: await getLastIntent(threadId),
        });
        if (audit.verdict === 'fail' && audit.revisedAnswer) {
          reply = audit.revisedAnswer;
        }
        const merged = { ...receipts, selfCheck: { verdict: audit.verdict, notes: audit.notes, scores: (audit as any).scores } };
        const safe = ReceiptsSchema.parse(merged);
        return ChatOutput.parse({ reply, threadId, sources: receipts.sources, receipts: safe });
      } catch {
        return ChatOutput.parse({ reply, threadId, sources: receipts.sources });
      }
    }

    // Resolve session as completed
    resolveSession(threadId, 'auto');
    
    return ChatOutput.parse({
      reply: verifiedReply,
      threadId,
      citations: result.citations,
    });
  }
  // Fallback if graph doesn't complete
  await pushMessage(threadId, {
    role: 'assistant',
    content: 'I need more information to help you.',
  });
  return ChatOutput.parse({
    reply: 'I need more information to help you.',
    threadId,
  });
}

type RouterResultT = {
  intent: string;
  needExternal: boolean;
  slots: Record<string, string>;
  confidence: number;
};

type PackingData = { hot: string[]; mild: string[]; cold: string[] };
let PACKING: PackingData = { hot: [], mild: [], cold: [] };
let packingLoaded = false;
async function loadPackingOnce() {
  if (packingLoaded) return;
  try {
    const file = path.join(process.cwd(), 'src', 'data', 'packing.json');
    const txt = await readFile(file, 'utf-8');
    PACKING = JSON.parse(txt) as PackingData;
    packingLoaded = true;
  } catch {
    PACKING = { hot: [], mild: [], cold: [] };
    packingLoaded = true;
  }
}

export async function blendWithFacts(
  input: { message: string; route: RouterResultT; threadId?: string },
  ctx: { log: pino.Logger; onStatus?: (status: string) => void },
) {
  // Single planner LLM call to drive all decisions
  const plan = await planBlend(input.message, input.route, ctx.log);
  
  // Early exits based on planner decisions
  if (plan.safety.disallowed_topic) {
    return {
      reply: plan.safety.reason || "I can't help with that topic. Please ask about travel planning instead.",
      citations: undefined,
    };
  }
  
  if (plan.unrelated) {
    return {
      reply: "I'm a travel assistant focused on helping with weather, destinations, packing, and attractions. Could you ask me something about travel planning?",
      citations: undefined,
    };
  }
  
  if (plan.system_question) {
    return {
      reply: 'I\'m an AI travel assistant designed to help with weather, destinations, packing advice, and attractions. How can I help with your travel planning?',
      citations: undefined,
    };
  }
  
  if (plan.explicit_search) {
    let searchQuery = input.message.replace(/^(search|google)\s+(web|online|for)?\s*/i, '').trim();
    if (!searchQuery) searchQuery = input.message;
    
    ctx.onStatus?.('Searching for travel information...');
    const optimizedQuery = await optimizeSearchQuery(
      searchQuery,
      input.route.slots,
      'web_search',
      ctx.log
    );
    
    return await performWebSearch(optimizedQuery, ctx, input.threadId, plan);
  }
  
  // Handle missing slots
  if (plan.missing_slots.length > 0) {
    const missing = plan.missing_slots[0];
    if (missing === 'city') {
      return { reply: "Which city are you interested in?", citations: undefined };
    }
    if (missing === 'dates') {
      return { reply: "When are you planning to travel?", citations: undefined };
    }
  }
  
  // Trust the slot extraction - if LLM found a city, use it
  const cityHint = input.route.slots.city && input.route.slots.city.trim();
  const whenHint = (input.route.slots.dates && input.route.slots.dates.trim()) || 
                   (input.route.slots.month && input.route.slots.month.trim());
                   
  if (input.route.intent === 'unknown') {
    // Use planner signal to avoid extra LLM calls
    if (plan.explicit_search) {
      ctx.log.debug({ intent: 'unknown', city: cityHint, webSearch: true }, 'unknown_intent_with_city_web_search');
      return await performWebSearch(input.message, ctx, input.threadId, plan);
    }
    return { reply: 'Could you share the city and month/dates?', citations: undefined };
  }
  
  // Check for restaurant/food queries in attractions intent
  if (input.route.intent === 'attractions') {
    if (plan.query_facets.wants_restaurants && input.threadId) {
      // Store the pending search query and set consent state
      updateThreadSlots(input.threadId, {
        awaiting_search_consent: 'true',
        pending_search_query: input.message
      }, []);
      
      const searchType = 'restaurant recommendations';
      return {
        reply: `I can search the web to find current ${searchType}. Would you like me to do that?`,
        citations: undefined,
      };
    }
  }
  
  // Avoid accidental web search for refinements; only trigger when explicitly asked
  if (input.route.intent === 'destinations' || input.route.intent === 'packing') {
    if (plan.explicit_search) {
      return await performWebSearch(input.message, ctx, input.threadId, plan);
    }
  }

  // Check for budget/cost queries in destinations intent
  if (input.route.intent === 'destinations') {
    if (plan.query_facets.wants_flights && input.threadId) {
      updateThreadSlots(input.threadId, {
        awaiting_search_consent: 'true',
        pending_search_query: input.message
      }, []);
      const searchType = 'flight and airline information';
      return {
        reply: `I can search the web to find current ${searchType}. Would you like me to do that?`,
        citations: undefined,
      };
    }
  }
  
  if (input.route.intent === 'weather') {
    if (!cityHint) {
      return { reply: 'Which city?', citations: undefined };
    }
  }
  if (input.route.intent === 'packing') {
    if (!cityHint) {
      return { reply: 'Which city?', citations: undefined };
    }
    // Ask for dates if no time context and no immediate context
    const hasImmediateContext = hasTemporalContext(input.message);
    if (!whenHint && !hasImmediateContext && !hasTravelContext(input.message)) {
      return { reply: 'Which month or travel dates?', citations: undefined };
    }
  }
  if (input.route.intent === 'destinations') {
    if (!cityHint) {
      return { reply: 'Which city?', citations: undefined };
    }
    // Use LLM to decide if dates are needed for this specific query
    if (!whenHint) {
      // If planner indicates web context, proceed without dates
      if (!(plan.explicit_search || plan.needs_web)) {
        return { reply: 'Which month or travel dates?', citations: undefined };
      }
    }
  }
  if (input.route.intent === 'attractions' && !cityHint) {
    return { reply: 'What city are you interested in?', citations: undefined };
  }
  
  const cits: string[] = [];
  let facts = '';
  const factsArr: Fact[] = [];
  const decisions: Array<string | Decision> = [];
  try {
    if (input.route.intent === 'weather') {
      ctx.onStatus?.('Checking weather data...');
      const wx = await getWeather({
        city: cityHint || 'Unknown',
        datesOrMonth: whenHint || 'today',
      });
      if (wx.ok) {
        const source = wx.source === getSearchSource() ? getSearchCitation() : 'Open-Meteo';
        // Use deterministic composer for weather
        const reply = composeWeatherReply(cityHint, whenHint || 'today', wx.summary, source);
        
        // Store facts for receipts
        if (input.threadId) {
          const factsArr: Fact[] = [{ source, key: 'weather_summary', value: wx.summary }];
          const decisions = [createDecision(
            'Used weather API for forecast',
            'User asked about weather conditions, so retrieved weather data from Open-Meteo API',
            ['Skip weather lookup', 'Use web search instead'],
            0.95
          )];
          await setLastReceipts(input.threadId, factsArr, decisions, reply);
        }
        
        // Metrics instrumentation
        incGeneratedAnswer();
        incAnswersWithCitations();
        try { (await import('../util/metrics.js')).incAnswerUsingExternal(); } catch {}
        
        return { reply, citations: [source] };
      } else {
        ctx.log.debug({ reason: wx.reason }, 'weather_adapter_failed');
        if (wx.reason === 'unknown_city') {
          return { 
            reply: `I couldn't find weather data for "${cityHint}". Could you provide a valid city name?`, 
            citations: undefined 
          };
        }
      }
    } else if (input.route.intent === 'packing') {
      ctx.onStatus?.('Preparing packing recommendations...');
      const wx = await getWeather({
        city: cityHint || 'Unknown',
        datesOrMonth: whenHint || 'today',
      });
      if (wx.ok) {
        const source = wx.source === getSearchSource() ? getSearchCitation() : 'Open-Meteo';
        
        // Get packing items based on weather
        await loadPackingOnce();
        const temps = parseTemps(wx.summary);
        const band = chooseBandFromTemps(temps?.maxC, temps?.minC);
        const items = band ? PACKING[band] : [];
        
        // Use deterministic composer for packing
        const reply = composePackingReply(cityHint, whenHint, wx.summary, items, source);
        
        // Store facts for receipts
        if (input.threadId) {
          const factsArr: Fact[] = [
            { source, key: 'weather_summary', value: wx.summary },
            { source, key: 'packing_items', value: items }
          ];
          const decisions = [createDecision(
            'Used weather data to tailor packing recommendations',
            'User asked for packing advice, so retrieved weather forecast and matched temperature ranges to appropriate clothing items',
            ['Generic packing list', 'Skip weather lookup'],
            0.9
          )];
          await setLastReceipts(input.threadId, factsArr, decisions, reply);
        }
        
        // Metrics instrumentation
        incGeneratedAnswer();
        incAnswersWithCitations();
        
        return { reply, citations: [source] };
      } else {
        ctx.log.debug({ reason: wx.reason }, 'weather_adapter_failed');
        // For packing, proceed with general guidance even if city lookup fails
      }
    } else if (input.route.intent === 'destinations') {
      // Check if this is a refinement of existing context
      const isRefinement = /\b(make it|kid[- ]?friendly|family|children|kids?)\b/i.test(input.message);
      const hasExistingContext = cityHint && whenHint;

      const lowerMessage = input.message.toLowerCase();
      const wantsOverview = /\b(tell me about|information about|info about|facts about|overview of|what is)\b/.test(lowerMessage);

      if (wantsOverview && (cityHint || input.route.slots.destinationCity || input.route.slots.country)) {
        const overviewTarget = (cityHint || input.route.slots.destinationCity || input.route.slots.country || '').trim();
        const factAttempts: Array<{ city?: string; country?: string }> = [
          { country: overviewTarget },
          { city: overviewTarget }
        ];

        for (const attempt of factAttempts) {
          const cf = await getCountryFacts(attempt);
          if (cf.ok) {
            const source = cf.source === getSearchSource() ? getSearchCitation() : 'REST Countries';
            const reply = `Here\'s an overview of ${overviewTarget}:\n${cf.summary}`;
            if (input.threadId) {
              const overviewFacts: Fact[] = [{ source, key: 'country_summary', value: cf.summary }];
              const overviewDecisions = [createDecision(
                `Provided overview for ${overviewTarget}`,
                'User asked for general information, so retrieved factual country overview instead of forcing trip planning slots.',
                ['Prompt for travel dates', 'Use generic template'],
                0.9
              )];
              await setLastReceipts(input.threadId, overviewFacts, overviewDecisions, reply);
            }
            incGeneratedAnswer();
            incAnswersWithCitations();
            try { (await import('../util/metrics.js')).incAnswerUsingExternal(); } catch {}
            return { reply, citations: [source] };
          }
        }

        const web = await performWebSearch(`Tell me about ${overviewTarget}`, ctx, input.threadId, plan);
        return web;
      }
      
      if (isRefinement && hasExistingContext) {
        // For refinements, use the existing context and add refinement guidance
        ctx.onStatus?.('Refining your travel recommendations...');
        ctx.log.debug({ intent: input.route.intent, slots: input.route.slots, isRefinement: true }, 'destinations_refinement_detected');
        
        // Add context-specific facts for the existing destination
        const contextFact = `EXISTING CONTEXT: Traveling from ${cityHint} in ${whenHint}. User requested refinement: ${input.message}`;
        facts += `${contextFact}\n`;
        decisions.push(createDecision(
          'Detected refinement request',
          'User is refining existing travel context rather than starting fresh, so preserved existing destination context and added specific adjustments',
          ['Start fresh search', 'Ignore refinement'],
          0.85
        ));
      } else {
        // For general city information without dates, use web search
        if (!whenHint && cityHint) {
          ctx.log.debug({ intent: input.route.intent, city: cityHint, hasDate: false }, 'destinations_general_info_query');
          return await performWebSearch(input.message, ctx, input.threadId, plan);
        }
        
        // Use destinations catalog for new recommendations with dates
        ctx.onStatus?.('Finding destinations...');
        ctx.log.debug({ intent: input.route.intent, slots: input.route.slots }, 'destinations_block_entered');

      }
      
      // Get weather for origin city (use originCity if available, fallback to city)
      const originCity = input.route.slots.originCity;
      if (originCity && whenHint) {
        const wx = await getWeather({
          city: originCity,
          datesOrMonth: whenHint || 'today',
        });
        if (wx.ok) {
          const source =
            wx.source === getSearchSource() ? getSearchCitation() : 'Open-Meteo';
          cits.push(source);
          facts += `Weather for ${originCity}: ${wx.summary} (${source})\n`;
          factsArr.push({ source, key: 'weather_summary', value: wx.summary });
          decisions.push(createDecision(
            'Considered origin weather/season for destination suggestions',
            'User requested destination recommendations, so retrieved origin city weather to provide seasonally-appropriate suggestions',
            ['Skip weather context', 'Use generic recommendations'],
            0.8
          ));
        } else {
          ctx.log.debug({ reason: wx.reason }, 'weather_adapter_failed');
          // Handle unknown city specifically
          if (wx.reason === 'unknown_city') {
            return { 
              reply: `I couldn't find weather data for "${originCity}". Could you provide a valid city name?`, 
              citations: undefined 
            };
          }
        }
        
        // Check if this is a country information query
        const isCountryQuery = /tell me about.*(?:country|spain|france|italy|germany|japan|canada|australia|brazil|mexico|india|china|russia|uk|usa|america)/i.test(input.message) || 
                              /(?:spain|france|italy|germany|japan|canada|australia|brazil|mexico|india|china|russia).*(?:country|as a country)/i.test(input.message);
        
        let countryTarget = originCity;
        if (isCountryQuery) {
          // Extract country name from the message
          const countryMatch = input.message.match(/(?:tell me about|about)\s+([a-z\s]+?)(?:\s+(?:as a|country)|$)/i);
          if (countryMatch && countryMatch[1]) {
            countryTarget = countryMatch[1].trim();
          }
        }
        
        const cf = await getCountryFacts({ 
          city: isCountryQuery ? undefined : originCity,
          country: isCountryQuery ? countryTarget : undefined 
        });
        if (cf.ok) {
          const source =
            cf.source === getSearchSource()
              ? getSearchCitation()
              : 'REST Countries';
          cits.push(source);
          facts += `Country: ${cf.summary} (${source})\n`;
          factsArr.push({ source, key: 'country_summary', value: cf.summary });
          decisions.push(createDecision(
            'Added country context (currency, language, region)',
            'User asked about destination, so retrieved country information to provide relevant context about currency, language, and regional details',
            ['Skip country lookup', 'Use generic information'],
            0.85
          ));
        } else {
          ctx.log.debug({ reason: cf.reason }, 'country_adapter_failed');
        }
      }
    } else if (input.route.intent === 'attractions') {
      // Prefer OpenTripMap results; avoid listing specific POIs from generic web search
      ctx.onStatus?.('Searching for attractions...');
      const wantsKid = /\b(kids?|children|child|3\s*-?\s*year|toddler|stroller|pram|family)\b/i.test(input.message);
      const at = await getAttractions({ city: cityHint, limit: 5, profile: wantsKid ? 'kid_friendly' : 'default' });
      if (at.ok && (at.source === 'opentripmap' || at.source === getSearchSource())) {
        const source = at.source === 'opentripmap' ? 'OpenTripMap' : getSearchCitation();
        
        // Use deterministic composer for attractions
        const attractions = at.summary.split(/;\s*/).map(s => s.trim()).filter(Boolean).slice(0, 5);
        const reply = composeAttractionsReply(cityHint || 'the area', attractions, source);
        
        // Store facts for receipts
        if (input.threadId) {
          const factsArr: Fact[] = [{ source, key: 'poi_list', value: at.summary }];
          const decisions = [createDecision(
            wantsKid ? 'Listed kid-friendly attractions from travel APIs' : 'Listed top attractions from travel APIs',
            wantsKid 
              ? 'User requested family-friendly attractions, so filtered results for kid-friendly venues using OpenTripMap API'
              : 'User asked for attractions, so retrieved top-rated points of interest using OpenTripMap API',
            ['Use web search instead', 'Skip attractions lookup'],
            0.9
          )];
          await setLastReceipts(input.threadId, factsArr, decisions, reply);
        }
        
        // Metrics instrumentation
        incGeneratedAnswer();
        incAnswersWithCitations();
        
        return { reply, citations: [source] };
      } else if (!at.ok && at.reason === 'unknown_city') {
        return {
          reply: `I'm unable to retrieve current attraction data for ${cityHint} right now. You might want to check local tourism websites or travel guides for the most up-to-date information about popular attractions, museums, and points of interest in the area.`,
          citations: undefined
        };
      }
    }
  } catch (e) {
    ctx.log.warn({ err: e }, 'facts retrieval failed');
    decisions.push(createDecision(
      'Facts retrieval encountered an error',
      'External API calls failed during fact gathering, so kept response generic to avoid providing incorrect information',
      ['Use cached data', 'Retry API calls'],
      0.7
    ));
  }
  
  ctx.onStatus?.('Preparing your response...');
  
  // For complex cases that need narrative generation, use batched LLM
  // Skip narrative rewriting for IRROPS - it has structured output
  if (plan.style === 'narrative' && input.route.intent !== 'irrops') {
    const systemMd = await getPrompt('system');
    const blendMd = await getPrompt('blend');
    const cotMd = await getPrompt('cot');
    
    // Include available slot context even when external APIs fail
    let contextInfo = '';
    if (cityHint && facts.trim() === '') {
      contextInfo = `Available context: City is ${cityHint}\n`;
    }

    const factsText = (contextInfo + facts) || '(none)';
    const cotPrompt = `${systemMd}\n\n${cotMd}\n\nAnalyze:\nSlots: ${JSON.stringify(input.route.slots)}\nFacts:\n${factsText}\nUser: ${input.message}`;
    const finalPrompt = `${systemMd}\n\n${
      blendMd?.includes('{{FACTS}}')
        ? blendMd.replace('{{FACTS}}', factsText).replace('{{USER}}', input.message)
        : `Facts:\n${factsText}\nUser: ${input.message}`
    }`;

    try {
      const [cotAnalysis, rawReply] = await callLLMBatch([cotPrompt, finalPrompt], { log: ctx.log });
      
      // Check if CoT suggests missing critical information
      if (cotAnalysis && cotAnalysis.includes('missing') && (cotAnalysis.includes('city') || cotAnalysis.includes('date'))) {
        const missingSlots = [];
        if (cotAnalysis.includes('missing') && cotAnalysis.includes('city') && !cityHint) {
          missingSlots.push('city');
        }
        if (cotAnalysis.includes('missing') && (cotAnalysis.includes('date') || cotAnalysis.includes('month')) && !whenHint) {
          missingSlots.push('dates');
        }
        
        if (missingSlots.length > 0) {
          const missing = missingSlots[0];
          if (missing === 'city') {
            return { reply: "Which city are you interested in?", citations: undefined };
          }
          if (missing === 'dates') {
            return { reply: "When are you planning to travel?", citations: undefined };
          }
        }
      }
      
      // Decode HTML entities from LLM response
      let reply = (rawReply || '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
        
      // Add mixed language warning if detected
      if (plan.mixed_languages) {
        reply = `Note: I work best with English, but I'll try to help. ${reply}`;
      }
      
      // Ensure a human-readable source mention appears once when external facts were used
      let replyWithSource = reply;
      if (cits.length > 0 && cits[0]) {
        const firstSource = cits[0] as string;
        const alreadyMentionsSource = new RegExp(`\\b${firstSource.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(replyWithSource);
        if (!alreadyMentionsSource) {
          replyWithSource = `${replyWithSource} (${firstSource})`;
        }
      }

      // Persist receipts components for this thread
      if (input.threadId && factsArr.length > 0) {
        try {
          await setLastReceipts(input.threadId, factsArr, decisions, replyWithSource);
        } catch {
          // ignore
        }
      }
      
      // Validate citations
      try {
        validateNoCitation(replyWithSource, cits.length > 0);
      } catch (err) {
        ctx.log.warn({ reply: replyWithSource, cits, hasExternal: cits.length > 0 }, 'citation_validation_failed');
      }
      
      // Metrics instrumentation
      incGeneratedAnswer();
      if (cits.length > 0) {
        incAnswersWithCitations();
        try { (await import('../util/metrics.js')).incAnswerUsingExternal(); } catch {}
      }
      
      return { reply: replyWithSource, citations: cits.length ? cits : undefined };
      
    } catch (e) {
      ctx.log.debug({ error: e }, 'Batched LLM generation failed');
      return {
        reply: 'I encountered an issue processing your request. Could you try rephrasing your question?',
        citations: undefined,
      };
    }
  }
  
  // Fallback for any remaining cases
  return {
    reply: 'Could you provide more details about what you\'re looking for?',
    citations: undefined,
  };
}

function extractCity(text: string): string | undefined {
  const m = text.match(/\b(?:in|to)\s+([A-Z][A-Za-z\- ]+(?:\s+[A-Z][A-Za-z\- ]+)*)/);
  const captured = m && m[1] ? m[1] : undefined;
  if (!captured) return undefined;
  const first = captured.split(/[.,!?]/)[0] || '';
  const out = first.trim();
  return out.length > 0 ? out : undefined;
}

function extractMonthOrDates(text: string): string | undefined {
  const m =
    text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\b/i) ??
    text.match(/\d{4}-\d{2}-\d{2}\s*\.\.\s*\d{4}-\d{2}-\d{2}/);
  return m?.[0];
}

function parseTemps(
  summary: string,
): { maxC: number; minC: number } | undefined {
  const m = summary.match(
    /High\s+(-?\d+(?:\.\d+)?)°C\s*\/\s*Low\s+(-?\d+(?:\.\d+)?)°C/i,
  );
  if (!m) return undefined;
  const maxC = Number(m[1]);
  const minC = Number(m[2]);
  return { maxC, minC };
}

function chooseBandFromTemps(
  maxC?: number,
  minC?: number,
): keyof PackingData | undefined {
  if (typeof maxC === 'number' && maxC >= 26) return 'hot';
  if (typeof minC === 'number' && minC <= 5) return 'cold';
  if (typeof maxC === 'number' || typeof minC === 'number') return 'mild';
  return undefined;
}
