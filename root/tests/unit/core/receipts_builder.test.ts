import { buildReceiptsSkeleton, createDecision } from '../../../src/core/receipts.js';

describe('Receipts builder', () => {
  it('creates sources and budgets from facts', () => {
    const facts = [
      { source: 'Brave Search', key: 'k1', value: 'v1', latency_ms: 20 },
      { source: 'Vectara', key: 'k2', value: 'v2', latency_ms: 30 },
      { source: 'Brave Search', key: 'k3', value: 'v3', latency_ms: 10 },
    ];
    const decisions = [
      'planned search',
      createDecision('vectaraQuery', 'retrieve policy', ['search'], 0.8),
    ];
    const out = buildReceiptsSkeleton(facts as any, decisions, 400);
    expect(out.sources.sort()).toEqual(['Brave Search', 'Vectara'].sort());
    expect(out.budgets.ext_api_latency_ms).toBe(60);
    expect(out.budgets.token_estimate).toBe(400);
    expect(out.decisions.length).toBe(2);
    expect(out.selfCheck.verdict).toBeDefined();
  });
});

