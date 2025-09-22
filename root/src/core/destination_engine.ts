
import { fetchCountriesByRegion } from '../tools/rest_countries_adapter';
import pino from 'pino';

const logger = pino({ name: 'DestinationEngine' });

// This is a placeholder for the DestinationEngine.
// The full implementation will use AWS Step Functions.

// List of countries to exclude from recommendations (war zones, extremely unsafe, unrecognized states, etc.)
const EXCLUDED_COUNTRIES = [
  'Afghanistan',
  'North Korea',
  'Syria',
  'Iraq',
  'Yemen',
  'Somalia',
  'South Sudan',
  'Central African Republic',
  'Palestine',
  'Libya',
  'Mali',
  'Burkina Faso',
  'Niger'
];

export class DestinationEngine {
  static async getRecommendations(preferences: any) {
    logger.info('DestinationEngine.getRecommendations called with: %o', preferences);
    
    // For now, we'll just fetch countries by region as a test.
    const region = preferences.region || preferences.city || 'Europe'; // Default to Europe
    logger.info('DestinationEngine using region: %s', region);
    
    try {
      const result: any = await fetchCountriesByRegion(region);
      logger.info('DestinationEngine.fetchCountriesByRegion result count: ' + result.length + ', sample: ' + JSON.stringify(result.slice(0, 2)));
      
      // Filter out excluded countries
      const filteredResult = result.filter((country: any) => 
        !EXCLUDED_COUNTRIES.includes(country.name.common)
      );
      
      logger.info('DestinationEngine.filtered result originalCount: ' + result.length + ', filteredCount: ' + filteredResult.length);
      
      return filteredResult;
    } catch (error: any) {
      logger.error('DestinationEngine.fetchCountriesByRegion error region: ' + region + ', error: ' + error.message + ', stack: ' + error.stack);
      throw error;
    }
  }
}
