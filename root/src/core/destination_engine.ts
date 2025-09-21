
import { fetchCountriesByRegion } from '../tools/rest_countries_adapter';
import pino from 'pino';

const logger = pino({ name: 'DestinationEngine' });

// This is a placeholder for the DestinationEngine.
// The full implementation will use AWS Step Functions.

export class DestinationEngine {
  static async getRecommendations(preferences: any) {
    logger.info('DestinationEngine.getRecommendations called with:', preferences);
    
    // For now, we'll just fetch countries by region as a test.
    const region = preferences.region || preferences.city || 'Europe'; // Default to Europe
    logger.info('DestinationEngine using region:', region);
    
    try {
      const result: any = await fetchCountriesByRegion(region);
      logger.info('DestinationEngine fetchCountriesByRegion result:', { 
        count: result.length, 
        sample: result.slice(0, 2) 
      });
      return result;
    } catch (error: any) {
      logger.error('DestinationEngine fetchCountriesByRegion error:', {
        error: error.message,
        stack: error.stack,
        region
      });
      throw error;
    }
  }
}
