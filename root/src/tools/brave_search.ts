import { BraveSearch } from 'brave-search';
import { getPrompt } from '../core/prompts.js';
import { callLLM } from '../core/llm.js';
import { deepResearchPages } from './crawlee_research.js';
import { withResilience } from '../util/resilience.js';
import { observeExternal } from '../util/metrics.js';

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export type Out =
  | { ok: true; results: SearchResult[]; deepSummary?: string; reason?: string; confidence?: number }
  | { ok: false; reason: string; confidence?: number };

function withTimeout(ms: number, signal?: AbortSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  const linked = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  return { signal: linked, cancel: () => clearTimeout(t) };
}

export async function searchTravelInfo(query: string, log?: any, deepResearch = false): Promise<Out> {
  if (!query.trim()) {
    if (log) log.debug(`❌ Brave Search: empty query`);
    return { ok: false, reason: 'no_query', confidence: 0.0 };
  }
  
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    if (log) log.debug(`❌ Brave Search: no API key configured`);
    return { ok: false, reason: 'no_api_key', confidence: 0.0 };
  }

  if (log) log.debug(`🔍 Brave Search: query="${query}", apiKey="${apiKey.slice(0, 10)}..."`);

  try {
    const braveSearch = new BraveSearch(apiKey);
    
    if (log) log.debug(`🔗 Brave Search: using wrapper for query`);
    
    const startTime = Date.now();
    
    // Use resilience wrapper to protect API call
    const response = await withResilience('brave', async () => {
      return await braveSearch.webSearch(query, {
        count: 20,
        text_decorations: false, // Cleaner text without HTML markup
        spellcheck: true
      });
    });
    
    const duration = Date.now() - startTime;
    if (log) log.debug(`✅ Brave Search success after ${duration}ms`);
    
    // Extract results from the wrapper response
    const results: SearchResult[] = [];
    
    if (response.web?.results) {
      for (const result of response.web.results) {
        results.push({
          title: result.title || '',
          url: result.url || '',
          description: result.description || ''
        });
      }
    }
    
    if (log) {
      log.debug(`✅ Brave Search success: ${results.length} results`);
      if (results.length > 0 && results[0]) {
        log.debug(`📝 First result: "${results[0].title}" - ${results[0].description?.slice(0, 100) || 'No description'}...`);
      }
    }
    
    // Perform deep research if requested
    let deepSummary: string | undefined;
    if (deepResearch && results.length > 0) {
      if (log) log.debug(`🔍 Starting deep research on ${Math.min(results.length, parseInt(process.env.CRAWLEE_MAX_PAGES || '4'))} pages`);
      
      try {
        const maxPages = parseInt(process.env.CRAWLEE_MAX_PAGES || '4');
        const urls = results.slice(0, maxPages).map(r => r.url);
        const crawlResult = await deepResearchPages(urls, query);
        
        if (crawlResult.ok && crawlResult.summary) {
          deepSummary = crawlResult.summary;
          if (log) log.debug(`📊 Deep research completed: ${deepSummary.slice(0, 100)}...`);
        } else {
          if (log) log.debug(`❌ Deep research failed: ${crawlResult.ok ? 'no summary' : 'crawl failed'}`);
        }
      } catch (error) {
        if (log) log.debug(`❌ Deep research error: ${error}`);
      }
    } else {
      if (log) log.debug(`⏭️ Skipping deep research: deepResearch=${deepResearch}, results=${results.length}`);
    }
    
    // Calculate confidence based on result quality
    const confidence = results.length === 0 ? 0.1 : 
                      results.length < 3 ? 0.5 :
                      deepSummary ? 0.9 : 0.7;
    
    return { ok: true, results, deepSummary, confidence };
    
  } catch (e) {
    if (log) {
      log.debug(`❌ Brave Search error:`, {
        error: e,
        message: e instanceof Error ? e.message : 'Unknown error',
        name: e instanceof Error ? e.name : undefined
      });
    }
    
    // Handle circuit breaker errors
    if (e instanceof Error && e.name === 'CircuitBreakerError') {
      if (log) log.debug(`🔌 Brave Search circuit breaker is open`);
      return { ok: false, reason: 'circuit_breaker_open', confidence: 0.0 };
    }
    
    // Handle different error types from the wrapper
    if (e instanceof Error) {
      const errorMessage = e.message.toLowerCase();
      
      if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
        if (log) log.debug(`🚫 Brave Search rate limited`);
        return { ok: false, reason: 'rate_limited', confidence: 0.0 };
      }
      
      if (errorMessage.includes('unauthorized') || errorMessage.includes('401') || errorMessage.includes('403')) {
        if (log) log.debug(`🔑 Brave Search authentication error`);
        return { ok: false, reason: 'auth_error', confidence: 0.0 };
      }
      
      if (errorMessage.includes('timeout')) {
        if (log) log.debug(`⏰ Brave Search timeout`);
        return { ok: false, reason: 'timeout', confidence: 0.0 };
      }
      
      if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
        if (log) log.debug(`🌐 Brave Search network error`);
        return { ok: false, reason: 'network', confidence: 0.0 };
      }
    }
    
    if (log) log.debug(`❓ Brave Search unknown error type: ${e?.constructor?.name || typeof e}`);
    return { ok: false, reason: 'unknown_error', confidence: 0.0 };
  }
}

/**
 * Extract weather information from search results
 */
export function extractWeatherFromResults(results: SearchResult[], city: string): string | null {
  const weatherKeywords = ['temperature', 'weather', 'forecast', 'climate', '°c', '°f', 'degrees'];
  
  for (const result of results) {
    const text = `${result.title} ${result.description}`.toLowerCase();
    if (weatherKeywords.some(keyword => text.includes(keyword)) && text.includes(city.toLowerCase())) {
      // Extract temperature ranges from description
      const tempMatch = text.match(/(\d+)°?[cf]?[\s-]*(?:to|-)[\s-]*(\d+)°?[cf]?/i) || 
                       text.match(/high[\s:]*(\d+)°?[cf]?.*low[\s:]*(\d+)°?[cf]?/i);
      if (tempMatch) {
        return `Based on recent data, expect ${tempMatch[1]}-${tempMatch[2]}°C in ${city}`;
      }
      // Fallback to first weather-related description
      return `Weather info for ${city}: ${result.description.slice(0, 100)}...`;
    }
  }
  return null;
}

/**
 * Extract country facts from search results
 */
export async function extractCountryFromResults(
  results: SearchResult[],
  country: string,
): Promise<string | null> {
  // Semantic extraction using LLM first
  const llmResult = await llmExtractCountryFromResults(results, country);
  if (llmResult) return llmResult;
  
  // Fallback to enhanced keyword matching
  const travelKeywords = ['currency', 'language', 'capital', 'visa', 'travel', 'timezone', 'culture'];
  
  for (const result of results) {
    const text = `${result.title} ${result.description}`.toLowerCase();
    const countryLower = country.toLowerCase();
    
    if (text.includes(countryLower) && travelKeywords.some(keyword => text.includes(keyword))) {
      // Extract relevant sentence containing travel info
      const sentences = result.description.split(/[.!?]+/);
      const relevantSentence = sentences.find(s => 
        s.toLowerCase().includes(countryLower) && 
        travelKeywords.some(k => s.toLowerCase().includes(k))
      );
      
      if (relevantSentence) {
        return `${country}: ${relevantSentence.trim()}`;
      }
      
      return `Travel info for ${country}: ${result.description.slice(0, 150)}...`;
    }
  }
  return null;
}

/**
 * LLM-first extraction: Weather summary from search results (fallback to heuristics elsewhere)
 */
export async function llmExtractWeatherFromResults(
  results: SearchResult[],
  city: string,
  log?: any,
): Promise<string | null> {
  try {
    const tpl = await getPrompt('search_extract_weather');
    const prompt = tpl
      .replace('{city}', city)
      .replace('{results}', JSON.stringify(results, null, 2));
    const raw = await callLLM(prompt, { responseFormat: 'json', log });
    const parsed = JSON.parse(raw || '{}') as { summary?: string };
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (summary) return summary;
  } catch (e) {
    if (log) log.debug?.('LLM weather extraction failed', { error: e instanceof Error ? e.message : String(e) });
  }
  return null;
}

/**
 * LLM-first extraction: Country facts summary from search results
 */
export async function llmExtractCountryFromResults(
  results: SearchResult[],
  country: string,
  log?: any,
): Promise<string | null> {
  try {
    const tpl = await getPrompt('search_extract_country');
    const prompt = tpl
      .replace('{country}', country)
      .replace('{results}', JSON.stringify(results, null, 2));
    const raw = await callLLM(prompt, { responseFormat: 'json', log });
    const parsed = JSON.parse(raw || '{}') as { summary?: string };
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (summary) return summary;
  } catch (e) {
    if (log) log.debug?.('LLM country extraction failed', { error: e instanceof Error ? e.message : String(e) });
  }
  return null;
}

/**
 * LLM-first extraction: Attractions list from search results
 */
export async function llmExtractAttractionsFromResults(
  results: SearchResult[],
  city: string,
  log?: any,
): Promise<string | null> {
  try {
    const tpl = await getPrompt('search_extract_attractions');
    const prompt = tpl
      .replace('{city}', city)
      .replace('{results}', JSON.stringify(results, null, 2));
    const raw = await callLLM(prompt, { responseFormat: 'json', log });
    const parsed = JSON.parse(raw || '{}') as { summary?: string };
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (summary) return summary;
  } catch (e) {
    if (log) log.debug?.('LLM attractions extraction failed', { error: e instanceof Error ? e.message : String(e) });
  }
  return null;
}
