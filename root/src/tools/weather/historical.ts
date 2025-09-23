import { z } from 'zod';
import { fetchJSON } from '../../util/fetch.js';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import Bottleneck from 'bottleneck';
import type { WeatherProvider, WeatherOptions, WeatherResult, HistoricalWeatherSchema, ClimateData } from './providers.js';

const HISTORICAL_URL = 'https://archive-api.open-meteo.com/v1/archive';

// Resilience policy for historical API
const retryPolicy = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 5000 }),
});

// Rate limiter for historical API (250 req/sec limit)
const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 250, // 4 requests per second to be conservative
});

export class HistoricalWeatherProvider implements WeatherProvider {
  async getWeather(lat: string, lon: string, options?: WeatherOptions): Promise<WeatherResult | null> {
    if (!options?.month) return null;
    
    const climateData = await this.getHistoricalClimate(lat, lon, options.month, options.year);
    if (!climateData) return null;
    
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    
    const monthName = monthNames[climateData.month - 1];
    const summary = `Typical ${monthName} weather: highs around ${climateData.avgHighC}°C, lows around ${climateData.avgLowC}°C, with ${climateData.precipitationMm}mm precipitation`;
    
    return {
      summary,
      source: 'historical',
      maxC: climateData.avgHighC,
      minC: climateData.avgLowC,
      precipitationMm: climateData.precipitationMm,
    };
  }
  
  private async getHistoricalClimate(lat: string, lon: string, month: number, year?: number): Promise<ClimateData | null> {
    try {
      // Use 30-year climate normal period (1991-2020) or recent years if specific year requested
      const endYear = year || 2020;
      const startYear = year || 1991;
      
      const url = `${HISTORICAL_URL}?latitude=${lat}&longitude=${lon}&start_date=${startYear}-01-01&end_date=${endYear}-12-31&daily=temperature_2m_max,temperature_2m_min,precipitation_sum`;
      
      console.log(`🌡️ HISTORICAL: Requesting ${url}`);
      
      const json = await retryPolicy.execute(async () => {
        return await limiter.schedule(() => fetchJSON<unknown>(url, {
          target: 'archive-api.open-meteo.com',
          headers: { 'Accept': 'application/json' },
        }));
      });
      
      const parsed = z.object({
        latitude: z.number(),
        longitude: z.number(),
        daily: z.object({
          time: z.array(z.string()),
          temperature_2m_max: z.array(z.number()),
          temperature_2m_min: z.array(z.number()),
          precipitation_sum: z.array(z.number()),
        }),
      }).safeParse(json);
      
      if (!parsed.success) {
        console.log(`🌡️ HISTORICAL: Schema validation failed:`, parsed.error);
        return null;
      }
      
      return this.aggregateByMonth(parsed.data, month);
    } catch (error) {
      console.log(`🌡️ HISTORICAL: Error:`, error);
      return null;
    }
  }
  
  private aggregateByMonth(data: z.infer<typeof HistoricalWeatherSchema>, targetMonth: number): ClimateData | null {
    const monthData: { highs: number[]; lows: number[]; precip: number[] } = {
      highs: [],
      lows: [],
      precip: [],
    };
    
    // Filter data for target month
    data.daily.time.forEach((dateStr, index) => {
      const date = new Date(dateStr);
      if (date.getMonth() + 1 === targetMonth) {
        const high = data.daily.temperature_2m_max[index];
        const low = data.daily.temperature_2m_min[index];
        const precip = data.daily.precipitation_sum[index];
        
        if (high !== undefined && !isNaN(high)) monthData.highs.push(high);
        if (low !== undefined && !isNaN(low)) monthData.lows.push(low);
        if (precip !== undefined && !isNaN(precip)) monthData.precip.push(precip);
      }
    });
    
    if (monthData.highs.length === 0) return null;
    
    // Calculate averages
    const avgHighC = Math.round(monthData.highs.reduce((a, b) => a + b, 0) / monthData.highs.length);
    const avgLowC = Math.round(monthData.lows.reduce((a, b) => a + b, 0) / monthData.lows.length);
    const precipitationMm = Math.round(monthData.precip.reduce((a, b) => a + b, 0) / monthData.precip.length);
    
    return {
      month: targetMonth,
      avgHighC,
      avgLowC,
      precipitationMm,
      source: 'historical',
    };
  }
}
