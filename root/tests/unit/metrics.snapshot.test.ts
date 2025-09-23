import { describe, it, expect } from '@jest/globals';
import {
  snapshotV2,
  incAnswersWithCitations,
  incAnswerUsingExternal,
  incGeneratedAnswer,
  incVerifyFail,
  incVerifyPass,
  observeE2E,
  observeExternal,
} from '../../src/util/metrics.js';

describe('metrics snapshot', () => {
  it('exposes v2 pipeline, quality, external, and system fields', () => {
    // mutate a few counters to ensure non-zero, but only assert existence/types
    incGeneratedAnswer();
    incVerifyPass();
    incVerifyFail('test');
    incAnswerUsingExternal();
    incAnswersWithCitations();
    observeE2E(123);
    observeExternal({ target: 'test_tool', status: 'timeout' }, 50);

    const s = snapshotV2() as any;

    // Pipeline
    expect(s.pipeline).toBeDefined();
    expect(Array.isArray(s.pipeline.stages)).toBe(true);
    expect(Array.isArray(s.pipeline.alerts)).toBe(true);

    // Quality
    expect(s.quality).toBeDefined();
    expect(Array.isArray(s.quality.verify)).toBe(true);
    expect(Array.isArray(s.quality.confidence)).toBe(true);

    // External requests aggregation with timeout rate
    expect(s.external.targets).toBeDefined();
    expect(Array.isArray(s.external.targets)).toBe(true);
    const t = s.external.targets.find((x: any) => x.target === 'test_tool');
    expect(t).toBeDefined();
    expect(typeof t.timeout_rate).toBe('number');

    // System
    expect(s.system).toBeDefined();
    expect(typeof s.system.active_sessions).toBe('number');
  });
});
