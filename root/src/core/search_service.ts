import type { Logger } from 'pino';
import { optimizeSearchQuery } from './llm.js';
import { summarizeSearch } from './searchSummarizer.js';
import { searchTravelInfo, getSearchCitation } from '../tools/search.js';
import type { SearchResult } from '../tools/search.js';
import { updateThreadSlots, setLastReceipts, setLastSearchConfidence } from './slot_memory.js';
import { createDecision } from './receipts.js';

/**
 * Sanitize a free-form web query string.
 * Ensures no prompts/markup leak into tool calls and bounds length.
 */
export function sanitizeSearchQuery(input: string): string {
  const stripped = (input || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(?:system:|assistant:|user:)\s*/gi, '')
    .replace(/[<>]/g, '')
    .trim();
  return stripped.slice(0, 512);
}

export type WebSearchOptions = {
  threadId?: string;
  log: Logger;
  onStatus?: (status: string) => void;
  summarizeWithLLM?: boolean;
  allowDeepResearch?: boolean;
};

/**
 * Unified web search pipeline: sanitize → optimize → search → summarize → receipts.
 * Writes receipts once and stores the last_search_query for upgrade flows.
 */
export async function performWebSearchUnified(
  query: string,
  slots: Record<string, string>,
  opts: WebSearchOptions,
): Promise<{ reply: string; citations: string[] }> {
  const { threadId, log } = opts;
  const sanitized = sanitizeSearchQuery(query);
  const optimized = await optimizeSearchQuery(sanitized, slots, 'web_search', log);

  if (threadId) {
    await updateThreadSlots(threadId, { last_search_query: optimized }, []);
  }

  const deep = Boolean(opts.allowDeepResearch) && (optimized.length > 50);
  const searchResult = await searchTravelInfo(optimized, log, deep);

  if (searchResult.confidence !== undefined && threadId) {
    await setLastSearchConfidence(threadId, searchResult.confidence);
  }

  if (!searchResult.ok) {
    return {
      reply: "I'm unable to search the web right now. Could you ask me something about weather, destinations, packing, or attractions instead?",
      citations: [],
    };
  }
  if (searchResult.results.length === 0) {
    return {
      reply: "I couldn't find relevant information for your search. Could you try rephrasing your question or ask me about weather, destinations, packing, or attractions?",
      citations: [],
    };
  }

  const useLLM = opts.summarizeWithLLM ?? (searchResult.results.length >= 3);
  const { reply, citations } = await summarizeSearch(
    searchResult.results,
    optimized,
    useLLM,
    { log },
  );

  // Store receipts (facts + a single decision)
  if (threadId) {
    const facts = searchResult.results.slice(0, 7).map((result: SearchResult, index: number) => ({
      source: getSearchCitation(),
      key: `search_result_${index}`,
      value: `${result.title}: ${result.description.slice(0, 100)}...`,
    }));
    const decisions = [createDecision(
      `Performed web search for: \"${optimized}\"`,
      'Question required external web search as it could not be answered by travel APIs or internal knowledge',
      ['Use travel APIs only', 'Skip search'],
      0.85,
    )];
    try {
      await setLastReceipts(threadId, facts, decisions, reply);
    } catch {
      // non-fatal; continue
    }
  }

  return { reply, citations };
}

