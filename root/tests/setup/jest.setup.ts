// Mock ES modules that cause issues in Jest
jest.mock('tavily', () => ({
  TavilyClient: jest.fn().mockImplementation(() => ({
    search: jest.fn().mockResolvedValue({
      results: [
        {
          title: 'Mock Result',
          url: 'https://example.com',
          content: 'Mock content',
          score: 0.9
        }
      ]
    })
  }))
}));

jest.mock('brave-search', () => ({
  BraveSearch: jest.fn().mockImplementation(() => ({
    search: jest.fn().mockResolvedValue({
      web: {
        results: [
          {
            title: 'Mock Brave Result',
            url: 'https://example.com',
            description: 'Mock description'
          }
        ]
      }
    })
  }))
}));

// Initialize session store globally for all tests
beforeAll(async () => {
  const { createStore, initSessionStore } = await import('../../src/core/session_store.js');
  const { loadSessionConfig } = await import('../../src/config/session.js');
  
  const cfg = loadSessionConfig();
  const store = createStore(cfg);
  initSessionStore(store);
});
