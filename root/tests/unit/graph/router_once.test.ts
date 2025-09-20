/**
 * Test: Router called exactly once per turn
 */

import { jest } from '@jest/globals';
import * as router from '../../../src/core/router.js';

describe('Router Once Pattern', () => {
  let routeIntentSpy: jest.SpiedFunction<typeof router.routeIntent>;

  beforeEach(() => {
    routeIntentSpy = jest.spyOn(router, 'routeIntent').mockResolvedValue({
      intent: 'weather',
      needExternal: true,
      confidence: 0.9,
      slots: { city: 'Barcelona' }
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should call routeIntent exactly once per turn', async () => {
    const { runGraphTurn } = await import('../../../src/core/graph.js');
    
    const result = await runGraphTurn(
      'weather in Barcelona today',
      'test-thread',
      { log: { debug: jest.fn(), warn: jest.fn(), info: jest.fn() } as any }
    );

    // Router should be called exactly once
    expect(routeIntentSpy).toHaveBeenCalledTimes(1);
    
    // Result should be either done or have next step
    expect(result).toBeTruthy();
    if ('done' in result) {
      expect(result.done).toBe(true);
    } else {
      expect(result.next).toBeTruthy();
    }
  });

  test('should not call routeIntent twice for weather queries', async () => {
    const { runGraphTurn } = await import('../../../src/core/graph.js');
    
    const result = await runGraphTurn(
      'what is the weather in Barcelona today?',
      'test-thread-2',
      { log: { debug: jest.fn(), warn: jest.fn(), info: jest.fn() } as any }
    );

    // Should still be exactly one call
    expect(routeIntentSpy).toHaveBeenCalledTimes(1);
    
    // Should have valid result
    expect(result).toBeTruthy();
    if ('done' in result) {
      expect(result.done).toBe(true);
    } else {
      expect(result.next).toBeTruthy();
    }
  });
});
