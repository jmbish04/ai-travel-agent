import pino from 'pino';

const log = pino({ level: (process.env.LOG_LEVEL as any) || 'silent' });
const ALLOW = process.env.VERIFY_LLM === '1' || process.env.VERIFY_LLM === 'true';

(ALLOW ? describe : describe.skip)('GOLDEN: weather→packing receipts + verification', () => {
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

  it('verifies packing suggestions grounded in curated items', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const makePlan = () => ({
        route: 'packing',
        confidence: 0.8,
        missing: [],
        consent: false,
        calls: [
          { tool: 'suggestPacking', args: { band: 'mild' } },
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
                { id: 'p1', type: 'function', function: { name: 'suggestPacking', arguments: JSON.stringify({ band: 'mild' }) } },
              ],
            },
          }],
        }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Pack light layers and a compact umbrella. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });

    jest.doMock('../../src/tools/packing', () => ({
      suggestPacking: async () => ({ ok: true, summary: 'light layers, compact umbrella', source: 'curated', band: 'mild', items: { base: ['t-shirt', 'jacket'], special: {} } })
    }));

    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'I am going to London next week, what should I pack?', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    
    // Wait for verification to complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Use direct import instead of helper
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    
    expect(artifact).toBeDefined();
    expect(['pass', 'warn', 'fail']).toContain(artifact!.verdict);
  }, 30000);
});
