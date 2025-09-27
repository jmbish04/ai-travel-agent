/**
 * Verifies that we inject the current date into both the planning
 * and main chat messages so the LLM resolves relative dates like
 * "tomorrow" correctly without heuristics.
 */

import pino from 'pino';

describe('Temporal context injection', () => {
  it('adds Current date (YYYY-MM-DD) to planner and main messages', async () => {
    const log = pino({ level: process.env.LOG_LEVEL || 'warn' });

    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const todayIso = new Date().toISOString().slice(0, 10);
      const plan = {
        route: 'flights',
        confidence: 0.9,
        missing: [],
        consent: { required: false },
        calls: [
          { tool: 'amadeusResolveCity', args: { keyword: 'Paris' } },
          { tool: 'amadeusResolveCity', args: { keyword: 'Berlin' } },
          { tool: 'amadeusSearchFlights', args: { origin: 'Paris', destination: 'Berlin', departureDate: 'tomorrow' } },
        ],
        blend: { style: 'short', cite: false },
        verify: { mode: 'none' },
      };

      const chatWithToolsLLM = jest.fn((opts: any) => {
        const sys = (opts?.messages || [])
          .filter((m: any) => m && m.role === 'system')
          .map((m: any) => String(m.content || ''))
          .join('\n');
        expect(sys).toContain(`Current date (YYYY-MM-DD): ${todayIso}`);
        const isControl = (opts?.messages || []).some((m: any) => m.role === 'user' && String(m.content || '').includes('CONTROL_REQUEST'));
        if (isControl) {
          return { choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] };
        }
        return { choices: [{ message: { role: 'assistant', content: 'Done.' } }] };
      });
      return { ...actual, chatWithToolsLLM };
    });

    // Stub Amadeus tools to avoid network
    jest.doMock('../../src/tools/amadeus_locations', () => ({
      resolveCity: async (kw: string) => ({ ok: true, cityCode: kw.toLowerCase().includes('paris') ? 'PAR' : 'BER' }),
      airportsForCity: async () => ({ ok: true, airports: ['PAR'] }),
    }));
    jest.doMock('../../src/tools/amadeus_flights', () => ({
      searchFlights: async () => ({ ok: true, summary: 'Found test offers', source: 'amadeus' }),
    }));

    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Find flights from Paris to Berlin tomorrow', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
  }, 30000);
});
