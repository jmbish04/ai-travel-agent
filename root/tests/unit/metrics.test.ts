import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  incTurn,
  incRouterLowConf,
  incClarify,
  incClarifyResolved,
  incFallback,
  incAnswersWithCitations,
  incVerifyFail,
  snapshot,
} from '../../src/util/metrics.js';

describe('Metrics', () => {
  beforeEach(() => {
    // Reset metrics by creating new snapshot
    snapshot();
  });

  it('should track chat turns by intent', () => {
    incTurn('weather');
    incTurn('flights');
    incTurn('weather');
    
    const snap = snapshot();
    expect(snap.chat_turns).toEqual({
      weather: 2,
      flights: 1,
    });
  });

  it('should track router low confidence decisions', () => {
    incRouterLowConf('unknown');
    incRouterLowConf('weather');
    
    const snap = snapshot();
    expect(snap.router_low_conf).toEqual({
      unknown: 1,
      weather: 1,
    });
  });

  it('should track clarification requests and resolutions', () => {
    incClarify('weather', 'city');
    incClarify('flights', 'dates');
    incClarifyResolved('weather');
    
    const snap = snapshot();
    expect(snap.clarify_requests).toEqual({
      'weather:city': 1,
      'flights:dates': 1,
    });
    expect(snap.clarify_resolved).toEqual({
      weather: 1,
    });
  });

  it('should track fallback usage', () => {
    incFallback('web');
    incFallback('browser');
    incFallback('web');
    
    const snap = snapshot();
    expect(snap.fallbacks).toEqual({
      web: 2,
      browser: 1,
    });
  });

  it('should track answers with citations', () => {
    incAnswersWithCitations();
    incAnswersWithCitations();
    
    const snap = snapshot();
    expect(snap.answers_with_citations_total).toBe(2);
  });

  it('should track verification failures by reason', () => {
    incVerifyFail('missing_fact');
    incVerifyFail('date_mismatch');
    incVerifyFail('missing_fact');
    
    const snap = snapshot();
    expect(snap.verify_fails).toEqual({
      missing_fact: 2,
      date_mismatch: 1,
    });
  });
});
