import { z } from 'zod';
import { fetchJSON } from '../util/fetch.js';
import { getSearchSource, searchTravelInfo } from './search.js';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import Bottleneck from 'bottleneck';
import { ForecastWeatherProvider } from './weather/forecast.js';
import { HistoricalWeatherProvider } from './weather/historical.js';
import { observeExternal } from '../util/metrics.js';
import { parseDate } from '../core/parsers.js';
import { isTemporalReference } from '../core/slot_memory.js';
import type pino from 'pino';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Define resilience policy for geocoding
const retryPolicy = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 5000 }),
});

// Define rate limiter for geocoding
const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 250, // 4 requests per second
});

const GeocodeSchema = z.object({
  results: z.array(
    z.object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string(),
    }),
  ),
});

// Initialize providers
const forecastProvider = new ForecastWeatherProvider();
const historicalProvider = new HistoricalWeatherProvider();

const RELATIVE_TIME_TOKENS = new Set([
  'today',
  'tonight',
  'tomorrow',
  'now',
  'currently',
  'right now',
  'this moment',
  'present',
  'this week',
  'this weekend',
  'this evening',
  'this morning'
]);

type ToolLogger = Pick<pino.Logger, 'debug' | 'info' | 'warn' | 'error'>;

async function getGeocode(city: string, log?: ToolLogger): Promise<{ lat: string; lon: string } | null> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(city)}`;
  log?.debug?.({ city, url }, 'weather.geocode.request');
  try {
    const json = await retryPolicy.execute(async () => {
      return await limiter.schedule(() => fetchJSON<unknown>(url, {
        target: 'geocoding-api.open-meteo.com',
        headers: { 'Accept': 'application/json' },
      }));
    });
    const parsed = GeocodeSchema.safeParse(json);
    if (!parsed.success) {
      log?.warn?.({ city, error: parsed.error.message }, 'weather.geocode.schema_failed');
      return null;
    }
    if (parsed.data.results.length === 0) {
      log?.debug?.({ city }, 'weather.geocode.no_results');
      return null;
    }
    const result = parsed.data.results[0];
    if (!result) {
      log?.debug?.({ city }, 'weather.geocode.no_primary_result');
      return null;
    }
    log?.debug?.({ city, lat: result.latitude, lon: result.longitude }, 'weather.geocode.success');
    return { lat: result.latitude.toString(), lon: result.longitude.toString() };
  } catch (error) {
    log?.warn?.({ city, error: error instanceof Error ? error.message : String(error) }, 'weather.geocode.error');
    return null;
  }
}

export async function getWeather(
  input: { city: string; datesOrMonth?: string; month?: string; dates?: string },
  log?: ToolLogger,
): Promise<
  | { ok: true; summary: string; source?: string; maxC?: number; minC?: number }
  | { ok: false; reason: string; source?: string }
> {
  const start = Date.now();
  log?.debug?.({ input }, 'weather.lookup.start');
  
  // Use pre-extracted slots from NLP pipeline
  const city = input.city;
  let month = input.month || input.datesOrMonth;
  let dates = input.dates;

  const monthToken = month?.toLowerCase().trim();
  if (monthToken && (RELATIVE_TIME_TOKENS.has(monthToken) || isTemporalReference(monthToken))) {
    dates = month;
    month = undefined;
  }
  
  // Determine query type for metrics
  const queryType = dates ? 'forecast' : month ? 'climate' : 'current';
  
  log?.debug?.({ city, month, dates }, 'weather.lookup.slots');
  
  try {
    const geocode = await getGeocode(city, log);
    log?.debug?.({ city, geocode }, 'weather.lookup.geocode_result');
    
    if (!geocode) {
      log?.debug?.({ city }, 'weather.lookup.geocode_missing');
      // Fallback to search if geocode fails
      const search = await searchTravelInfo(`weather in ${city}`, log as any);
      if (search.ok && search.results.length > 0) {
        const first = search.results[0];
        if (first) {
          log?.debug?.({ city }, 'weather.lookup.search_fallback.success');
          observeExternal({
            target: 'weather',
            status: 'ok',
            query_type: 'search_fallback',
            location: city.slice(0, 20)
          }, Date.now() - start);
          return { ok: true, summary: `${first.title} - ${first.description}`, source: getSearchSource() };
        }
      }
      log?.warn?.({ city }, 'weather.lookup.fallback_failed');
      observeExternal({
        target: 'weather',
        status: 'error',
        query_type: queryType,
        location: city.slice(0, 20)
      }, Date.now() - start);
      return { ok: false, reason: 'unknown_city', source: 'geocoding-api.open-meteo.com' };
    }
    
    // Determine which provider to use based on whether we have future month queries
    const isFutureMonth = month && !dates; // Month without specific dates suggests future climate query
    log?.debug?.({ city, isFutureMonth }, 'weather.lookup.provider');
    
    let weatherResult;
    if (isFutureMonth) {
      // Use historical provider for month-based climate queries
      const monthNumber = await resolveMonthNumber(month);
      weatherResult = await historicalProvider.getWeather(geocode.lat, geocode.lon, {
        month: monthNumber,
      });
    } else {
      // Use forecast provider for current/near-term weather
      weatherResult = await forecastProvider.getWeather(geocode.lat, geocode.lon, {});
    }
    
    if (!weatherResult) {
      log?.warn?.({ city, isFutureMonth }, 'weather.lookup.provider_failed');
      observeExternal({
        target: 'weather',
        status: 'error',
        query_type: queryType,
        location: city.slice(0, 20)
      }, Date.now() - start);
      return { ok: false, reason: 'weather_unavailable', source: 'open-meteo.com' };
    }
    
    // Determine source string for response
    const sourceMap = {
      forecast: 'open-meteo.com',
      historical: 'archive-api.open-meteo.com',
    };
    
    log?.debug?.({ city, provider: weatherResult.source }, 'weather.lookup.success');
    observeExternal({
      target: 'weather',
      status: 'ok',
      query_type: queryType,
      location: city.slice(0, 20)
    }, Date.now() - start);
    
    return {
      ok: true,
      summary: weatherResult.summary,
      source: sourceMap[weatherResult.source],
      maxC: weatherResult.maxC,
      minC: weatherResult.minC,
    };
  } catch (error) {
    observeExternal({
      target: 'weather',
      status: 'error',
      query_type: queryType,
      location: city.slice(0, 20)
    }, Date.now() - start);
    log?.error?.({ city, error: error instanceof Error ? error.message : String(error) }, 'weather.lookup.exception');
    throw error;
  }
}

// Month resolver without regex or hardcoded maps.
// Uses existing LLM date parser and JS Date to infer month number.
async function resolveMonthNumber(monthStr?: string): Promise<number | undefined> {
  const text = (monthStr || '').trim();
  if (!text) return undefined;
  try {
    const parsed = await parseDate(text);
    // Prefer exact normalized date if available
    const candidate = (parsed.data?.dates || parsed.data?.month || '').trim();
    if (!candidate) return undefined;
    // Try to construct a date object safely
    const tryVals = [candidate, `${candidate} 1`, `${candidate} 1, 2025`];
    for (const val of tryVals) {
      const d = new Date(val);
      if (!isNaN(d.getTime())) {
        const month = d.getMonth() + 1;
        if (month >= 1 && month <= 12) return month;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
