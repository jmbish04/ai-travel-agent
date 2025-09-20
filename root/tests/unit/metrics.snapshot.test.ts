import { describe, it, expect } from '@jest/globals';
import {
  snapshot,
  incAnswersWithCitations,
  incAnswerUsingExternal,
  incGeneratedAnswer,
  incVerifyFail,
  incVerifyPass,
  observeE2E,
  observeExternal,
} from '../../src/util/metrics.js';

describe('metrics snapshot', () => {
  it('exposes business, quality, flow, and performance fields', () => {
    // mutate a few counters to ensure non-zero, but only assert existence/types
    incGeneratedAnswer();
    incVerifyPass();
    incVerifyFail('test');
    incAnswerUsingExternal();
    incAnswersWithCitations();
    observeE2E(123);
    observeExternal({ target: 'test_tool', status: 'timeout' }, 50);

    const s = snapshot() as any;

    // Business
    expect(s.business).toBeDefined();
    expect(typeof s.business.fcr_rate).toBe('number');
    expect(typeof s.business.deflection_rate).toBe('number');
    expect(s.business.session_outcomes).toBeDefined();

    // Quality
    expect(s.quality).toBeDefined();
    expect(typeof s.quality.verify_pass_rate).toBe('number');
    expect(typeof s.quality.verify_fail_rate).toBe('number');
    expect(typeof s.quality.citation_coverage).toBe('number');
    expect(typeof s.quality.clarification_efficacy).toBe('number');

    // Flow
    expect(s.chat_turns).toBeDefined();
    expect(s.router_low_conf).toBeDefined();
    expect(s.router_confidence_buckets).toBeDefined();

    // Performance
    expect(s.performance).toBeDefined();
    expect(s.performance.e2e_latency_ms).toBeDefined();
    expect(typeof s.performance.tool_calls_per_turn).toBe('number');

    // External requests aggregation with timeout rate
    expect(s.external_requests.targets).toBeDefined();
    expect(Array.isArray(s.external_requests.targets)).toBe(true);
    const t = s.external_requests.targets.find((x: any) => x.target === 'test_tool');
    expect(t).toBeDefined();
    expect(typeof t.timeout_rate).toBe('number');
  });
});

