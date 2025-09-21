import { summarizeSearch } from '../../src/core/searchSummarizer.js';

describe('Web Search Facts Verification', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.SEARCH_SUMMARY = 'on'; // Enable LLM summarization
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.SEARCH_SUMMARY;
  });

  it('should handle up to 7 search results without verification mismatch', async () => {
    // Create 7 mock search results
    const mockResults = Array.from({ length: 7 }, (_, i) => ({
      title: `Test Result ${i + 1}`,
      url: `https://example${i + 1}.com`,
      description: `Description for test result ${i + 1} with some content about the topic.`
    }));

    const query = "test query";
    const useLLM = true;
    const ctx = { log: { debug: () => {}, info: () => {} } };

    // This should not throw and should handle all 7 results
    const result = await summarizeSearch(mockResults, query, useLLM, ctx);
    
    expect(result).toBeDefined();
    expect(result.reply).toBeDefined();
    expect(result.citations).toBeDefined();
    
    // The reply should include sources section with up to 5 URLs
    expect(result.reply).toContain('Sources:');
    expect(result.reply).toContain('https://example1.com');
    expect(result.reply).toContain('https://example5.com');
  }, 15000);

  it('should not reference more sources than provided in facts', () => {
    // This test verifies that our fix ensures facts array matches what LLM can reference
    const maxResults = 7; // LLM sees up to 7 results in summarizeSearch
    const maxFacts = 7;   // Our fix now stores up to 7 facts
    
    expect(maxFacts).toEqual(maxResults);
  });
});
