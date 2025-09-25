import pino from 'pino';
import { handleChat } from '../../src/core/blend.js';
import { fetchLastVerification } from '../helpers/verify.js';

const log = pino({ level: (process.env.LOG_LEVEL as any) || 'silent' });
const ALLOW = process.env.VERIFY_LLM === '1' || process.env.VERIFY_LLM === 'true';

(ALLOW ? describe : describe.skip)('GOLDEN: attractions receipts + verification', () => {
  beforeAll(() => {
    process.env.AUTO_VERIFY_REPLIES = 'true';
    jest.resetModules();
  });

  it('verifies a kid-friendly attractions reply grounded in stubbed sources', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const makePlan = () => ({
        route: 'attractions',
        confidence: 0.85,
        missing: [],
        consent: false,
        calls: [
          { tool: 'search', args: { query: 'kid friendly attractions in Paris', deep: false } },
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
                { id: 's1', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: 'kid friendly attractions in Paris', deep: false }) } },
              ],
            },
          }],
        }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'In Paris, Jardin d’Acclimatation and Cité des Sciences are great for kids. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });

    jest.doMock('../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: 'Jardin d’Acclimatation; Cité des Sciences', source: 'Brave Search', results: [] }),
      getSearchCitation: () => 'Brave Search',
      getSearchSource: () => 'brave-search',
    }));

    const out = await handleChat({ message: 'Kid-friendly activities in Paris?', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    const artifact = await fetchLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass', 'warn', 'fail']).toContain(artifact!.verdict);
  }, 15000);
});

