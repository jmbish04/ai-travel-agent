/**
 * Golden: Policy conversation with receipts + LLM verification pass-through.
 * - Stubs tool adapters for determinism
 * - Real verifying LLM only when VERIFY_LLM=1
 */
import pino from 'pino';
import { fetchLastVerification } from '../helpers/verify.js';

const log = pino({ level: (process.env.LOG_LEVEL as any) || 'silent' });

const ALLOW = process.env.VERIFY_LLM === '1' || process.env.VERIFY_LLM === 'true';

(ALLOW ? describe : describe.skip)('GOLDEN: policy receipts + verification', () => {
  beforeAll(() => {
    process.env.AUTO_VERIFY_REPLIES = 'true';
    jest.resetModules();
  });

  it('stores receipts and a verification artifact', async () => {
    // Only mock tool-calling path; keep callLLM real for verification
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const makePlan = () => ({
        route: 'policy',
        confidence: 0.85,
        missing: [],
        consent: true,
        calls: [
          { tool: 'vectaraQuery', args: { query: 'Marriott hotels standard cancellation window and penalties', corpus: 'hotels' } },
          { tool: 'search', args: { query: 'site:marriott.com cancellation policy', deep: false } },
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
                { id: 'c1', type: 'function', function: { name: 'vectaraQuery', arguments: JSON.stringify({ query: 'Marriott hotels standard cancellation window and penalties', corpus: 'hotels' }) } },
                { id: 'c2', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: 'site:marriott.com cancellation policy', deep: false }) } },
              ],
            },
          }],
        }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Most Marriott flexible rates allow free cancellation until 48–72 hours before arrival; after that typically one night room + tax applies. Always confirm on the property page.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });

    jest.doMock('../../src/tools/vectara', () => ({
      VectaraClient: class VectaraClient {
        async query() {
          return { summary: 'Typical window 24–72 hours before arrival; after that one night + tax.', hits: [], citations: [{ url: 'https://www.marriott.com/loyalty/terms' }] } as any;
        }
      }
    }));
    jest.doMock('../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: 'Official site states 48–72 hours in most cases.', source: 'Brave Search', results: [] }),
      getSearchCitation: () => 'Brave Search',
      getSearchSource: () => 'brave-search',
    }));

    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'What is Marriott cancellation window and penalty?', receipts: true }, { log });
    expect(typeof out.threadId).toBe('string');
    expect(typeof out.reply).toBe('string');

    const artifact = await fetchLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass', 'warn', 'fail']).toContain(artifact!.verdict);
    if (artifact?.scores) {
      expect(artifact.scores.relevance).toBeGreaterThanOrEqual(0);
      expect(artifact.scores.relevance).toBeLessThanOrEqual(1);
    }
  }, 15000);
});
