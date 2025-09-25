import pino from 'pino';
import { setupHttpMocks, teardownHttpMocks } from '../../helpers/http.js';

describe('Policy execution fallback on LLM timeout uses facts + sources', () => {
  beforeAll(() => setupHttpMocks());
  afterAll(() => teardownHttpMocks());
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns minimal grounded reply with Sources when final LLM times out', async () => {
    jest.doMock('../../../src/core/llm', () => {
      const makePlan = () => ({
        route: 'policy',
        confidence: 0.8,
        missing: [],
        consent: true,
        calls: [
          { tool: 'vectaraQuery', args: { query: 'Marriott policy window and penalty', corpus: 'hotels' } },
          { tool: 'search', args: { query: 'site:marriott.com cancellation policy', deep: false } },
        ],
        blend: true,
        verify: true,
      });
      const chatWithToolsLLM = jest
        .fn()
        // planning
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(makePlan()) } }] }))
        // step0 -> tool_calls
        .mockImplementationOnce(() => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'vectaraQuery', arguments: JSON.stringify({ query: 'Marriott policy window and penalty', corpus: 'hotels' }) } },
                { id: 'c2', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: 'site:marriott.com cancellation policy', deep: false }) } },
              ],
            },
          }],
        }))
        // step1 -> timeout error (no message)
        .mockImplementationOnce(() => ({ error: { message: 'llm_tools_timeout' }, choices: [] }));
      const callLLM = jest.fn().mockResolvedValue('{"isComplex":false,"confidence":0.8,"reasoning":"simple"}');
      return { chatWithToolsLLM, callLLM };
    });

    jest.doMock('../../../src/tools/vectara', () => ({
      VectaraClient: class VectaraClient {
        async query() {
          return { summary: '24 hours window; after that one night penalty.', hits: [], citations: [{ url: 'https://www.marriott.com/terms' }] } as any;
        }
      }
    }));
    jest.doMock('../../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: '48 hours in some cases; otherwise 24 hours.', source: 'Tavily Search', results: [] }),
      getSearchCitation: () => 'https://example.com',
      getSearchSource: () => 'web',
    }));
    jest.doMock('../../../src/tools/packing', () => ({
      suggestPacking: async () => ({ ok: true, summary: 'stub packing', source: 'stub', band: 'mild', items: { base: [], special: {} } })
    }));

    const { callChatWithTools } = await import('../../../src/agent/tools/index.js');
    const { result, citations, facts } = await callChatWithTools({
      system: 'You are a meta agent.',
      user: 'What is Marriott cancellation window and penalty?',
      context: {},
      maxSteps: 6,
      timeoutMs: 12000,
      log: pino({ level: 'silent' }),
    });

    expect(facts.length).toBeGreaterThan(0);
    expect(result).toMatch(/Sources:/);
    const joined = (citations || []).join(' ');
    expect(joined).toMatch(/marriott|Tavily|vectara:doc|example\.com/i);
  });
});
