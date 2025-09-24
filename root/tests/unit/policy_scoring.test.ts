import { policyUrlHeuristicScore } from '../../src/tools/policy_browser.js';

describe('policyUrlHeuristicScore', () => {
  test('prefers help/legal pages over loyalty terms for baggage', () => {
    const a = 'https://www.jetblue.com/help/changes-cancellations-and-standby';
    const b = 'https://trueblue.jetblue.com/terms-and-conditions';
    const sa = policyUrlHeuristicScore(a, 'baggage');
    const sb = policyUrlHeuristicScore(b, 'baggage');
    expect(sa).toBeGreaterThan(sb);
    expect(sb).toBeLessThan(0.5);
  });

  test('prefers legal/fees page for change/refund topics', () => {
    const fees = 'https://www.jetblue.com/legal/fees';
    const toc = 'https://www.jetblue.com/terms-and-conditions';
    const sFees = policyUrlHeuristicScore(fees, 'change');
    const sToc = policyUrlHeuristicScore(toc, 'change');
    expect(sFees).toBeGreaterThan(sToc);
  });
});

