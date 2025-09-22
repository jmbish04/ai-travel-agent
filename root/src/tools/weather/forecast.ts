import { z } from 'zod';
import { fetchJSON } from '../../util/fetch.js';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import Bottleneck from 'bottleneck';
import type { WeatherProvider, WeatherOptions, WeatherResult } from './providers.js';

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

const retryPolicy = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 5000 }),
});

const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 250, // 4 requests per second
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

export class ForecastWeatherProvider implements WeatherProvider {
  async getWeather(lat: string, lon: string, options?: WeatherOptions): Promise<WeatherResult | null> {
    const forecastDays = this.calculateForecastDays(options?.targetDate);
    const url = `${WEATHER_URL}?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&forecast_days=${forecastDays}`;
    
    console.log(`🌤️ FORECAST: Requesting ${url}`);
    
    try {
      const json = await retryPolicy.execute(async () => {
        return await limiter.schedule(() => fetchJSON<unknown>(url, {
          target: 'open-meteo.com',
          headers: { 'Accept': 'application/json' },
        }));
      });
      
      const parsed = WeatherSchema.safeParse(json);
      if (!parsed.success) {
        console.log(`🌤️ FORECAST: Schema validation failed:`, parsed.error);
        return null;
      }
      
      const data = parsed.data;
      const code = data.daily.weathercode[0];
      const max = data.daily.temperature_2m_max[0];
      const min = data.daily.temperature_2m_min[0];
      
      if (code === undefined || max === undefined || min === undefined) {
        console.log(`🌤️ FORECAST: Missing data in response`);
        return null;
      }
      
      const summary = `${weatherCodeToText(code)} with a high of ${max}°C and a low of ${min}°C`;
      
      console.log(`🌤️ FORECAST: Success - ${summary}`);
      
      return {
        summary,
        source: 'forecast',
        maxC: max,
        minC: min,
      };
    } catch (error) {
      console.log(`🌤️ FORECAST: Error:`, error);
      return null;
    }
  }
  
  private calculateForecastDays(targetDate?: Date): number {
    if (!targetDate) return 3; // Default 3-day forecast
    
    const horizonDays = Math.ceil((targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return Math.min(Math.max(horizonDays, 1), 16); // Clamp between 1-16 days
  }
}
