import pino from 'pino';

const log = pino({ level: (process.env.LOG_LEVEL as any) || 'silent' });
const ALLOW = process.env.VERIFY_LLM === '1' || process.env.VERIFY_LLM === 'true';

(ALLOW ? describe : describe.skip)('GOLDEN: policy receipts + verification', () => {
  beforeAll(async () => {
    process.env.AUTO_VERIFY_REPLIES = 'true';
    jest.resetModules();
    
    // Initialize session store after module reset
    const { createStore, initSessionStore } = await import('../../src/core/session_store.js');
    const { loadSessionConfig } = await import('../../src/config/session.js');
    const cfg = { ...loadSessionConfig(), kind: 'memory' as const };
    const store = createStore(cfg);
    initSessionStore(store);
  });

  it('stores receipts and a verification artifact', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const makePlan = () => ({
        route: 'policy',
        confidence: 0.9,
        missing: [],
        consent: false,
        calls: [
          { tool: 'search', args: { query: 'Marriott cancellation policy', deep: false } },
        ],
        blend: 'concise',
        verify: true,
      });
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(makePlan()) } }] }))
        .mockImplementationOnce(() => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'p1', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: 'Marriott cancellation policy', deep: false }) } },
              ],
            },
          }],
        }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Marriott allows free cancellation up to 48-72 hours before check-in. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });

    jest.doMock('../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: 'Marriott cancellation policy 48-72 hours', source: 'Brave Search', results: [] }),
      getSearchCitation: () => 'Brave Search',
      getSearchSource: () => 'brave-search',
    }));

    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'What is Marriott cancellation window and penalty?', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    
    // Wait for verification to complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Use direct import instead of helper
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    
    expect(artifact).toBeDefined();
    expect(['pass', 'warn', 'fail']).toContain(artifact!.verdict);
    if (artifact?.scores) {
      expect(artifact.scores.relevance).toBeGreaterThanOrEqual(0);
      expect(artifact.scores.relevance).toBeLessThanOrEqual(1);
    }
  }, 30000);
});
