
import { getCountriesByRegion } from '@yusifaliyevpro/countries';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import Bottleneck from 'bottleneck';
import { CountrySchema } from '../schemas/destination';
import pino from 'pino';

const logger = pino({ name: 'RestCountriesAdapter' });

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

export async function fetchCountriesByRegion(region: string) {
  logger.info('fetchCountriesByRegion called with region: ' + region);
  
  try {
    const result: any = await retryPolicy.execute(async ({ signal }) => {
      logger.info('fetchCountriesByRegion: calling getCountriesByRegion with signal');
      const countries = await limiter.schedule(() => {
        logger.info('fetchCountriesByRegion: inside limiter.schedule');
        return getCountriesByRegion({ region: region as any }, { signal });
      });
      logger.info('fetchCountriesByRegion: got countries, count: ' + (countries?.length || 0));
      
      // Log first few countries for debugging
      if (countries && Array.isArray(countries) && countries.length > 0) {
        logger.info('fetchCountriesByRegion: first country sample count: ' + countries.length + ', first: ' + JSON.stringify(countries.slice(0, 2)));
      } else {
        logger.warn('fetchCountriesByRegion: no countries returned or invalid format type: ' + typeof countries + ', isArray: ' + Array.isArray(countries) + ', value: ' + JSON.stringify(countries));
      }
      
      logger.info('fetchCountriesByRegion: attempting to parse with CountrySchema');
      const parsed = CountrySchema.array().parse(countries);
      logger.info('fetchCountriesByRegion: parsed countries, count: ' + parsed.length);
      return parsed;
    });
    logger.info('fetchCountriesByRegion: final result count: ' + result.length);
    return result;
  } catch (error: any) {
    logger.error('fetchCountriesByRegion error message: ' + error.message + ', region: ' + region + ', error: ' + JSON.stringify(error) + ', stack: ' + error.stack);
    throw error;
  }
}
