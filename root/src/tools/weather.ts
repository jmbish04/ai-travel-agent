import { z } from 'zod';
import { fetchJSON, ExternalFetchError } from '../util/fetch.js';
import { getSearchSource, searchTravelInfo } from './search.js';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import Bottleneck from 'bottleneck';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

// Define resilience policy
const retryPolicy = retry(handleAll, {
    maxAttempts: 3,
    backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 5000 }),
});

// Define rate limiter
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

const WeatherSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  daily: z.object({
    time: z.array(z.string()),
    weathercode: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
  }),
});

function weatherCodeToText(code: number): string {
  const map: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow fall',
    73: 'Moderate snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return map[code] || 'Unknown';
}

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

async function getMeteoWeather(lat: string, lon: string): Promise<{ summary: string; maxC: number; minC: number } | null> {
  const url = `${WEATHER_URL}?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&forecast_days=3`;
  console.log(`🌤️ WEATHER: Requesting ${url}`);
  try {
    const json = await retryPolicy.execute(async () => {
      return await limiter.schedule(() => fetchJSON<unknown>(url, {
        target: 'open-meteo.com',
        headers: { 'Accept': 'application/json' },
      }));
    });
    console.log(`🌤️ WEATHER: Raw response:`, JSON.stringify(json, null, 2));
    const parsed = WeatherSchema.safeParse(json);
    if (!parsed.success) {
      console.log(`🌤️ WEATHER: Schema validation failed:`, parsed.error);
      return null;
    }
    const j: any = parsed.data;
    const code = j.daily.weathercode[0];
    const max = j.daily.temperature_2m_max[0];
    const min = j.daily.temperature_2m_min[0];
    const summary = `${weatherCodeToText(code)} with a high of ${max}°C and a low of ${min}°C`;
    console.log(`🌤️ WEATHER: Success - ${summary}, maxC: ${max}, minC: ${min}`);
    return { summary, maxC: max, minC: min };
  } catch (error) {
    console.log(`🌤️ WEATHER: Error:`, error);
    return null;
  }
}

export async function getWeather(input: { city: string; datesOrMonth?: string }): Promise<
  | { ok: true; summary: string; source?: string; maxC?: number; minC?: number }
  | { ok: false; reason: string; source?: string }
> {
  console.log(`🌍 WEATHER: Starting weather lookup for ${input.city}`);
  const geocode = await getGeocode(input.city);
  console.log(`🗺️ Geocode result:`, geocode);
  if (!geocode) {
    console.log(`🌍 WEATHER: Geocoding failed, falling back to search`);
    // Fallback to Brave search if geocode fails
    const search = await searchTravelInfo(`weather in ${input.city}`, null as any);
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
  console.log(`🌡️ Getting weather for coordinates: ${geocode.lat}, ${geocode.lon}`);
  const weather = await getMeteoWeather(geocode.lat, geocode.lon);
  console.log(`🌤️ Weather result:`, weather);
  if (!weather) {
    console.log(`🌍 WEATHER: Weather API failed`);
    return { ok: false, reason: 'weather_unavailable', source: 'open-meteo.com' };
  }
  console.log(`🌍 WEATHER: Success with OpenMeteo`);
  return { ok: true, summary: weather.summary, source: 'open-meteo.com', maxC: weather.maxC, minC: weather.minC };
}

