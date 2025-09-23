import { TavilyClient } from 'tavily';
import { deepResearchPages } from './crawlee_research.js';
import { withResilience } from '../util/resilience.js';
import { observeExternal } from '../util/metrics.js';
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
    observeExternal({
      target: 'search',
      status: 'error',
      query_type: 'empty'
    }, Date.now() - start);
    return { ok: false, reason: 'no_query' };
  }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    log?.debug?.('❌ Tavily: no API key configured');
    observeExternal({
      target: 'search',
      status: 'error',
      query_type: 'no_api_key'
    }, Date.now() - start);
    return { ok: false, reason: 'no_api_key' };
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
  
    const results: SearchResult[] = res.results?.map((r: TavilyResult) => ({
      title: r.title || '',
      url: r.url || '',
      description: r.content || '',
    })) ?? [];
    
    let deepSummary = res.answer?.trim();
    if (deepResearch && results.length > 0) {
      try {
        const maxPages = parseInt(process.env.CRAWLEE_MAX_PAGES || '8', 10);
        const urls = results.slice(0, maxPages).map(r => r.url);
        const crawl = await deepResearchPages(urls, query);
        if (crawl.ok && crawl.summary) deepSummary = crawl.summary;
      } catch (e) {
        log?.debug?.(`❌ Tavily deep research error: ${e}`);
      }
    }
    
    observeExternal({
      target: 'search',
      status: 'ok',
      query_type: searchType,
      domain: queryComplexity
    }, Date.now() - start);
    
    return { ok: true, results, deepSummary };
  } catch (e: unknown) {
    log?.debug?.('❌ Tavily error', e);
    
    const msg = e instanceof Error ? e.message.toLowerCase() : '';
    if (msg.includes('circuit') || msg.includes('breaker')) {
      observeExternal({
        target: 'search',
        status: 'breaker_open',
        query_type: searchType,
        domain: queryComplexity
      }, Date.now() - start);
      return { ok: false, reason: 'circuit_breaker_open' };
    }
    if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
      observeExternal({
        target: 'search',
        status: '4xx',
        query_type: searchType,
        domain: queryComplexity
      }, Date.now() - start);
      return { ok: false, reason: 'auth_error' };
    }
    if (msg.includes('429') || msg.includes('rate')) {
      observeExternal({
        target: 'search',
        status: '4xx',
        query_type: searchType,
        domain: queryComplexity
      }, Date.now() - start);
      return { ok: false, reason: 'rate_limited' };
    }
    if (msg.includes('timeout')) {
      observeExternal({
        target: 'search',
        status: 'timeout',
        query_type: searchType,
        domain: queryComplexity
      }, Date.now() - start);
      return { ok: false, reason: 'timeout' };
    }
    if (msg.includes('network') || msg.includes('fetch')) {
      observeExternal({
        target: 'search',
        status: 'network',
        query_type: searchType,
        domain: queryComplexity
      }, Date.now() - start);
      return { ok: false, reason: 'network' };
    }
    
    observeExternal({
      target: 'search',
      status: 'error',
      query_type: searchType,
      domain: queryComplexity
    }, Date.now() - start);
    return { ok: false, reason: 'unknown_error' };
  }
}
