import { searchTravelInfo as braveSearch } from './brave_search.js';
import { searchTravelInfo as tavilySearch } from './tavily_search.js';
import { observeExternal, observeSearchQuality, observeConfidenceOutcome } from '../util/metrics.js';
import { assessQueryComplexity } from '../core/complexity.js';
import type { Out } from './brave_search.js';

export {
  extractWeatherFromResults,
  extractCountryFromResults,
  llmExtractWeatherFromResults,
  llmExtractCountryFromResults,
  llmExtractAttractionsFromResults,
} from './brave_search.js';
export type { SearchResult, Out } from './brave_search.js';

function provider(): string {
  return (process.env.SEARCH_PROVIDER || 'brave').toLowerCase();
}

export function getSearchSource(): string {
  return provider() === 'tavily' ? 'tavily-search' : 'brave-search';
}

export function getSearchCitation(): string {
  return provider() === 'tavily' ? 'Tavily Search' : 'Brave Search';
}

/** Dispatch to configured search provider */
export async function searchTravelInfo(
  query: string,
  log?: any,
  deepResearch = false,
): Promise<Out> {
  const start = Date.now();
  
  // Start complexity assessment async (don't block search)
  const complexityPromise = assessQueryComplexity(query, log).catch(() => 
    ({ isComplex: false, confidence: 0, reasoning: 'assessment_failed' })
  );
  
  const queryComplexity = query.length > 50 ? 'complex' : 'simple'; // fallback for immediate use
  const searchType = deepResearch ? 'deep' : 'basic';
  
  try {
    const result = provider() === 'tavily'
      ? await tavilySearch(query, log, deepResearch)
      : await braveSearch(query, log, deepResearch);
    
    observeExternal({
      target: 'search',
      status: result.ok ? 'ok' : 'error',
      query_type: searchType,
      domain: queryComplexity
    }, Date.now() - start);
    
    // Track search quality metrics async (don't block response)
    if (result.ok) {
      complexityPromise.then(complexity => {
        observeSearchQuality(complexity, result.results.length, false);
        try {
          // Correlate assessed complexity confidence with success
          observeConfidenceOutcome('search', Math.max(0, Math.min(1, complexity.confidence ?? 0)), true);
        } catch {}
      }).catch(() => {}); // ignore metrics failures
    }
    
    return result;
  } catch (error) {
    observeExternal({
      target: 'search',
      status: 'error',
      query_type: searchType,
      domain: queryComplexity
    }, Date.now() - start);
    throw error;
  }
}
