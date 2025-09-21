import { optimizeSearchQuery } from '../../src/core/llm.js';

describe('Web Search Query Update', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.NER_MODE = 'local';
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.NER_MODE;
  });

  it('should generate new search query for follow-up hotel request', async () => {
    // Simulate the scenario: user previously asked about Paris, now asks about hotels
    const currentMessage = "Best hotels there right now";
    const contextSlots = { 
      city: 'Paris',
      search_query: 'paris france overview tourist attractions history', // old query
      last_search_query: 'paris france overview tourist attractions history'
    };
    
    const optimized = await optimizeSearchQuery(currentMessage, contextSlots, 'web_search');
    
    // Should generate a new query about Paris hotels, not reuse the old attractions/history query
    expect(optimized.toLowerCase()).toContain('paris');
    expect(optimized.toLowerCase()).toContain('hotel');
    expect(optimized.toLowerCase()).not.toContain('attractions');
    expect(optimized.toLowerCase()).not.toContain('history');
  }, 10000);

  it('should handle location pronouns in follow-up queries', async () => {
    const testCases = [
      {
        message: "Best restaurants there",
        context: { city: 'Tokyo' },
        expectedContains: ['tokyo', 'restaurant']
      },
      {
        message: "Weather there tomorrow", 
        context: { city: 'London' },
        expectedContains: ['london', 'weather']
      },
      {
        message: "Attractions there for families",
        context: { city: 'Barcelona' },
        expectedContains: ['barcelona', 'attraction', 'famil']
      }
    ];

    for (const { message, context, expectedContains } of testCases) {
      const optimized = await optimizeSearchQuery(message, context, 'web_search');
      
      for (const term of expectedContains) {
        expect(optimized.toLowerCase()).toContain(term);
      }
    }
  }, 15000);
});
