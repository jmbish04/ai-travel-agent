import { z } from 'zod';
import { fetchJSON, ExternalFetchError } from '../util/fetch.js';
import { getSearchSource, searchTravelInfo } from './search.js';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import Bottleneck from 'bottleneck';

const GEOCODE_URL = 'https://geocode.maps.co/search';
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

const GeocodeSchema = z.array(
  z.object({
    lat: z.string(),
    lon: z.string(),
    display_name: z.string(),
  }),
);

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
  const url = `${GEOCODE_URL}?q=${encodeURIComponent(city)}`;
  try {
    const json = await retryPolicy.execute(async () => {
      return await limiter.schedule(() => fetchJSON<unknown>(url, {
        target: 'geocode.maps.co',
        headers: { 'Accept': 'application/json' },
      }));
    });
    const parsed = GeocodeSchema.safeParse(json);
    if (!parsed.success || parsed.data.length === 0) return null;
    const g: any = parsed.data[0];
    return { lat: g.lat, lon: g.lon };
  } catch {
    return null;
  }
}

async function getMeteoWeather(lat: string, lon: string): Promise<string | null> {
  const url = `${WEATHER_URL}?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&forecast_days=3`;
  try {
    const json = await retryPolicy.execute(async () => {
      return await limiter.schedule(() => fetchJSON<unknown>(url, {
        target: 'open-meteo.com',
        headers: { 'Accept': 'application/json' },
      }));
    });
    const parsed = WeatherSchema.safeParse(json);
    if (!parsed.success) return null;
    const j: any = parsed.data;
    const code = j.daily.weathercode[0];
    const max = j.daily.temperature_2m_max[0];
    const min = j.daily.temperature_2m_min[0];
    return `${weatherCodeToText(code)} with a high of ${max}°C and a low of ${min}°C`;
  } catch {
    return null;
  }
}

export async function getWeather(input: { city: string; datesOrMonth?: string }): Promise<
  | { ok: true; summary: string; source?: string }
  | { ok: false; reason: string; source?: string }
> {
  const geocode = await getGeocode(input.city);
  if (!geocode) {
    // Fallback to Brave search if geocode fails
    const search = await searchTravelInfo(`weather in ${input.city}`, null as any);
    if (search.ok && search.results.length > 0) {
      const first = search.results[0];
      if (first) {
        return { ok: true, summary: `${first.title} - ${first.description}`, source: getSearchSource() };
      }
    }
    return { ok: false, reason: 'unknown_city', source: 'geocode.maps.co' };
  }
  const weather = await getMeteoWeather(geocode.lat, geocode.lon);
  if (!weather) {
    return { ok: false, reason: 'weather_unavailable', source: 'open-meteo.com' };
  }
  return { ok: true, summary: weather, source: 'open-meteo.com' };
}

