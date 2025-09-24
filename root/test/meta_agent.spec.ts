// Minimal smoke test skeleton for meta agent. Requires Jest setup in the
// repository to run. This file is a placeholder to guide test coverage.
import { runMetaAgentTurn } from '../src/agent/meta_agent.js';

describe('meta_agent', () => {
  it('handles weather with relative dates', async () => {
    const out = await runMetaAgentTurn('Weather in Paris today', 't_meta_1');
    expect(typeof out.reply).toBe('string');
  }, 30000);

  it('resolves flights with city names and relative date', async () => {
    const out = await runMetaAgentTurn('Flights from New York to London tomorrow', 't_meta_2');
    expect(typeof out.reply).toBe('string');
  }, 60000);
});

