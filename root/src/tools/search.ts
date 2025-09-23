import { searchTravelInfo as braveSearch } from './brave_search.js';
import { searchTravelInfo as tavilySearch } from './tavily_search.js';
import { observeExternal } from '../util/metrics.js';
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
  
  // Determine query complexity for metrics
  const queryComplexity = query.length > 100 ? 'complex' : 
                         query.split(' ').length > 10 ? 'medium' : 'simple';
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
