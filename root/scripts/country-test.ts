
import { getCountriesByRegion } from '@yusifaliyevpro/countries';

async function runTest() {
  try {
    const countries = await getCountriesByRegion({ region: 'Asia' });
    console.log('Countries in Asia:', countries);
  } catch (error) {
    console.error('Error fetching countries:', error);
  }
}

runTest();
