
import { DestinationEngine } from '../../src/core/destination_engine';
import { fetchCountriesByRegion } from '../../src/tools/rest_countries_adapter';

jest.mock('../../src/tools/rest_countries_adapter');

describe('DestinationEngine', () => {
  it('should return a list of countries for a given region', async () => {
    const mockCountries = [
      { name: { common: 'France' }, capital: ['Paris'] },
      { name: { common: 'Germany' }, capital: ['Berlin'] },
    ];
    (fetchCountriesByRegion as jest.Mock).mockResolvedValue(mockCountries);

    const recommendations = await DestinationEngine.getRecommendations({ region: 'Europe' });

    expect(recommendations).toEqual(mockCountries);
    expect(fetchCountriesByRegion).toHaveBeenCalledWith('Europe');
  });
});
