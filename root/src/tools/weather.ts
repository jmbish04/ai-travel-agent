import { z } from 'zod';
import { fetchJSON } from '../util/fetch.js';
import { getSearchSource, searchTravelInfo } from './search.js';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import Bottleneck from 'bottleneck';
import { ForecastWeatherProvider } from './weather/forecast.js';
import { HistoricalWeatherProvider } from './weather/historical.js';

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

async function getGeocode(city: string): Promise<{ lat: string; lon: string } | null> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(city)}`;
  console.log(`🌍 GEOCODE: Requesting ${url}`);
  try {
    const json = await retryPolicy.execute(async () => {
      return await limiter.schedule(() => fetchJSON<unknown>(url, {
        target: 'geocoding-api.open-meteo.com',
        headers: { 'Accept': 'application/json' },
      }));
    });
    console.log(`🌍 GEOCODE: Raw response:`, JSON.stringify(json, null, 2));
    const parsed = GeocodeSchema.safeParse(json);
    if (!parsed.success) {
      console.log(`🌍 GEOCODE: Schema validation failed:`, parsed.error);
      return null;
    }
    if (parsed.data.results.length === 0) {
      console.log(`🌍 GEOCODE: No results found for ${city}`);
      return null;
    }
    const result = parsed.data.results[0];
    if (!result) {
      console.log(`🌍 GEOCODE: No results found for ${city}`);
      return null;
    }
    console.log(`🌍 GEOCODE: Success - lat: ${result.latitude}, lon: ${result.longitude}`);
    return { lat: result.latitude.toString(), lon: result.longitude.toString() };
  } catch (error) {
    console.log(`🌍 GEOCODE: Error:`, error);
    return null;
  }
}

export async function getWeather(input: { city: string; datesOrMonth?: string; month?: string; dates?: string }): Promise<
  | { ok: true; summary: string; source?: string; maxC?: number; minC?: number }
  | { ok: false; reason: string; source?: string }
> {
  console.log(`🌍 WEATHER: Starting weather lookup for ${input.city}`);
  
  // Use pre-extracted slots from NLP pipeline
  const city = input.city;
  const month = input.month || input.datesOrMonth;
  const dates = input.dates;
  
  console.log(`🌍 WEATHER: Using slots - city: ${city}, month: ${month}, dates: ${dates}`);
  
  const geocode = await getGeocode(city);
  console.log(`🗺️ Geocode result:`, geocode);
  
  if (!geocode) {
    console.log(`🌍 WEATHER: Geocoding failed, falling back to search`);
    // Fallback to search if geocode fails
    const search = await searchTravelInfo(`weather in ${city}`, null as any);
    if (search.ok && search.results.length > 0) {
      const first = search.results[0];
      if (first) {
        console.log(`🌍 WEATHER: Search fallback successful`);
        return { ok: true, summary: `${first.title} - ${first.description}`, source: getSearchSource() };
      }
    }
    console.log(`🌍 WEATHER: Both geocoding and search failed`);
    return { ok: false, reason: 'unknown_city', source: 'geocoding-api.open-meteo.com' };
  }
  
  // Determine which provider to use based on whether we have future month queries
  const isFutureMonth = month && !dates; // Month without specific dates suggests future climate query
  console.log(`🌍 WEATHER: Using ${isFutureMonth ? 'historical' : 'forecast'} provider for ${isFutureMonth ? 'climate' : 'forecast'} data`);
  
  let weatherResult;
  if (isFutureMonth) {
    // Use historical provider for month-based climate queries
    const monthNumber = parseMonthName(month);
    weatherResult = await historicalProvider.getWeather(geocode.lat, geocode.lon, {
      month: monthNumber,
    });
  } else {
    // Use forecast provider for current/near-term weather
    weatherResult = await forecastProvider.getWeather(geocode.lat, geocode.lon, {});
  }
  
  console.log(`🌤️ Weather result:`, weatherResult);
  
  if (!weatherResult) {
    console.log(`🌍 WEATHER: Weather API failed`);
    return { ok: false, reason: 'weather_unavailable', source: 'open-meteo.com' };
  }
  
  // Determine source string for response
  const sourceMap = {
    forecast: 'open-meteo.com',
    historical: 'archive-api.open-meteo.com',
  };
  
  console.log(`🌍 WEATHER: Success with ${weatherResult.source} provider`);
  return {
    ok: true,
    summary: weatherResult.summary,
    source: sourceMap[weatherResult.source],
    maxC: weatherResult.maxC,
    minC: weatherResult.minC,
  };
}

function parseMonthName(monthStr: string): number | undefined {
  const monthMap: Record<string, number> = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
    april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
    august: 8, aug: 8, september: 9, sep: 9, october: 10, oct: 10,
    november: 11, nov: 11, december: 12, dec: 12
  };
  return monthMap[monthStr.toLowerCase()];
}

