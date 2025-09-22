import { z } from 'zod';

export interface WeatherOptions {
  targetDate?: Date;
  month?: number;
  year?: number;
}

export interface WeatherResult {
  summary: string;
  source: 'forecast' | 'historical';
  maxC?: number;
  minC?: number;
  precipitationMm?: number;
}

export interface WeatherProvider {
  getWeather(lat: string, lon: string, options?: WeatherOptions): Promise<WeatherResult | null>;
}

export const HistoricalWeatherSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    precipitation_sum: z.array(z.number()),
  }),
});

export interface ClimateData {
  month: number;
  avgHighC: number;
  avgLowC: number;
  precipitationMm: number;
  source: 'historical';
}
