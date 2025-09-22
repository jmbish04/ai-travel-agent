import { describe, it, expect, jest } from '@jest/globals';
import { HistoricalWeatherProvider } from '../../src/tools/weather/historical.js';

// Mock the fetch utility
jest.mock('../../src/util/fetch.js', () => ({
  fetchJSON: jest.fn(),
}));

describe('HistoricalWeatherProvider', () => {
  const provider = new HistoricalWeatherProvider();

  it('should return null for queries without month', async () => {
    const result = await provider.getWeather('41.9', '12.5', {});
    expect(result).toBeNull();
  });

  it('should format climate summary correctly', async () => {
    const mockData = {
      latitude: 41.9,
      longitude: 12.5,
      daily: {
        time: ['2020-12-01', '2020-12-02', '2020-12-15', '2019-12-10'],
        temperature_2m_max: [15, 18, 12, 16],
        temperature_2m_min: [5, 8, 2, 6],
        precipitation_sum: [0, 5, 10, 2],
      },
    };

    // Mock the fetchJSON function
    const { fetchJSON } = require('../../src/util/fetch.js');
    (fetchJSON as jest.MockedFunction<any>).mockResolvedValue(mockData);

    const result = await provider.getWeather('41.9', '12.5', { month: 12 });
    
    expect(result).toBeDefined();
    expect(result?.source).toBe('historical');
    expect(result?.summary).toContain('Typical December weather');
    expect(result?.maxC).toBeDefined();
    expect(result?.minC).toBeDefined();
    expect(result?.precipitationMm).toBeDefined();
  });

  it('should handle API errors gracefully', async () => {
    const { fetchJSON } = require('../../src/util/fetch.js');
    (fetchJSON as jest.MockedFunction<any>).mockRejectedValue(new Error('API Error'));

    const result = await provider.getWeather('41.9', '12.5', { month: 6 });
    expect(result).toBeNull();
  });
});
