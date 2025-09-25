import { TavilyClient } from 'tavily';
import { deepResearchPages } from './crawlee_research.js';
import { isHostBlocked } from '../util/blocked_hosts.js';
import { withResilience } from '../util/resilience.js';
import type { SearchResult, Out } from './brave_search.js';

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  answer?: string;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

/**
 * Search for travel information using Tavily API
 */
export async function searchTravelInfo(
  query: string,
  log?: any,
  deepResearch = false,
): Promise<Out> {
  const start = Date.now();
  
  if (!query.trim()) {
    log?.debug?.('❌ Tavily: empty query');
    return { ok: false, reason: 'no_query', confidence: 0.0 };
  }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    log?.debug?.('❌ Tavily: no API key configured');
    return { ok: false, reason: 'no_api_key', confidence: 0.0 };
  }
  
  // Determine query complexity for metrics
  const queryComplexity = query.length > 100 ? 'complex' : 
                         query.split(' ').length > 10 ? 'medium' : 'simple';
  const searchType = deepResearch ? 'deep' : 'basic';
  
  try {
    const client = new TavilyClient({ apiKey });
    const start = Date.now();
    
    const res: TavilyResponse = await withResilience('tavily', () =>
      client.search({
        query,
        search_depth: 'advanced',
        include_answer: true,
        include_images: false,
        max_results: 20,
      })
    );
    
    const duration = Date.now() - start;
    log?.debug?.(`✅ Tavily success after ${duration}ms`);
  
    let results: SearchResult[] = res.results?.map((r: TavilyResult) => ({
      title: r.title || '',
      url: r.url || '',
      description: r.content || '',
    })) ?? [];
    // Filter blocked hosts
    results = results.filter(r => {
      try { return !isHostBlocked(new URL(r.url).hostname); } catch { return true; }
    });
    
    let deepSummary = res.answer?.trim();
    if (deepResearch && results.length > 0) {
      try {
        const maxPages = parseInt(process.env.CRAWLEE_MAX_PAGES || '4', 10);
        const urls = results.slice(0, maxPages).map(r => r.url);
        const crawl = await deepResearchPages(urls, query);
        if (crawl.ok && crawl.summary) deepSummary = crawl.summary;
      } catch (e) {
        log?.debug?.(`❌ Tavily deep research error: ${e}`);
      }
    }
    
    // Calculate confidence based on result quality
    const confidence = results.length === 0 ? 0.1 : 
                      results.length < 3 ? 0.5 :
                      deepSummary ? 0.9 : 0.7;
    
    return { ok: true, results, deepSummary, confidence };
  } catch (e: unknown) {
    log?.debug?.('❌ Tavily error', e);
    
    const msg = e instanceof Error ? e.message.toLowerCase() : '';
    if (msg.includes('circuit') || msg.includes('breaker')) {
      return { ok: false, reason: 'circuit_breaker_open', confidence: 0.0 };
    }
    if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
      return { ok: false, reason: 'auth_error', confidence: 0.0 };
    }
    if (msg.includes('429') || msg.includes('rate')) {
      return { ok: false, reason: 'rate_limited', confidence: 0.0 };
    }
    if (msg.includes('timeout')) {
      return { ok: false, reason: 'timeout', confidence: 0.0 };
    }
    if (msg.includes('network') || msg.includes('fetch')) {
      return { ok: false, reason: 'network', confidence: 0.0 };
    }
    
    return { ok: false, reason: 'unknown_error', confidence: 0.0 };
  }
}
