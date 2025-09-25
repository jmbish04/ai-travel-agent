import pino from 'pino';

// Mock LLM tool-calling API to simulate plan → echo → tool_call → final
jest.mock('../../src/core/llm', () => {
  const seq: any[] = [];
  const makePlan = () => ({
    route: 'policy',
    confidence: 0.85,
    missing: [],
    consent: true,
    calls: [
      { tool: 'vectaraQuery', args: { query: 'Marriott hotels standard cancellation window and penalties', corpus: 'hotels' } },
      { tool: 'search', args: { query: 'cancellation policy site:marriott.com', deep: false } },
    ],
    blend: 'concise',
    verify: true,
  });
  const chatWithToolsLLM = jest.fn()
    // planning call
    .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(makePlan()) } }] }))
    // first tool loop: provider erroneously echoes planning JSON (no tool_calls)
    .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(makePlan()) } }] }))
    // second tool loop: produce a vectaraQuery tool call
    .mockImplementationOnce(() => ({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'vectaraQuery', arguments: JSON.stringify({ query: 'Marriott hotels standard cancellation window and penalties', corpus: 'hotels' }) } },
          ],
        },
      }],
    }))
    // final: produce a blended answer
    .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Most Marriott flexible rates allow free cancellation until 48–72 hours before arrival; after that, a one night room + tax penalty typically applies. Always confirm on the specific property page.' } }] }));

  const callLLM = jest.fn().mockResolvedValue('{"isComplex":false,"confidence":0.8,"reasoning":"simple"}');
  return { chatWithToolsLLM, callLLM };
});

// Mock search tool module to avoid loading ESM deps
jest.mock('../../src/tools/search', () => ({
  searchTravelInfo: async (q: string, deep?: boolean) => ({ ok: true, summary: 'stub search', source: 'web', results: [] }),
  getSearchCitation: () => 'https://example.com',
  getSearchSource: () => 'web',
}));

// Mock packing tool to avoid ESM and import.meta issues
jest.mock('../../src/tools/packing', () => ({
  suggestPacking: async () => ({ ok: true, summary: 'stub packing', source: 'stub', band: 'mild', items: { base: [], special: {} } })
}));

// Mock query complexity to avoid network
jest.mock('../../src/core/complexity', () => ({
  assessQueryComplexity: async () => ({ isComplex: false, confidence: 0.8, reasoning: 'simple' }),
}));

// Mock Vectara client
jest.mock('../../src/tools/vectara', () => ({
  VectaraClient: class VectaraClient {
    async query(q: string, opts: any) {
      return {
        summary: 'Typical window 24–72 hours before arrival; then 1 night + tax.',
        hits: [ { url: 'https://www.marriott.com/loyalty/terms', title: 'Terms', documentId: 'doc-123' } ],
        citations: [ { url: 'https://www.marriott.com/loyalty/terms' } ],
      } as any;
    }
  }
}));

import { callChatWithTools } from '../../src/agent/tools/index';

describe('Policy planning transitions to execution (Vectara + search)', () => {
  it('executes planned vectaraQuery even if the model echoes planning JSON first', async () => {
    const { result, facts, citations } = await callChatWithTools({
      system: 'You are a meta agent.',
      user: 'What is the standard cancellation window for Marriott hotels, and what penalty applies after?',
      context: {},
      maxSteps: 6,
      timeoutMs: 10000,
      log: pino({ level: 'silent' }),
    });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/cancellation/i);
    // Ensure at least one fact was captured from vectara
    expect(Array.isArray(facts)).toBe(true);
    expect(facts.length).toBeGreaterThan(0);
    // Ensure citations include vectara doc label or marriott domain
    const joined = (citations || []).join(' ');
    expect(joined).toMatch(/marriott\.com|vectara:doc/);
  });
});
