/**
 * Tests for optimized graph implementation
 * Validates G-E-R-A pattern and performance improvements
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { runGraphTurn } from '../../../src/core/graph.js';
import pinoLib from 'pino';

// Mock dependencies with Jest
jest.mock('../../../src/core/router.js', () => ({
  routeIntent: jest.fn().mockResolvedValue({
    intent: 'weather',
    confidence: 0.8,
    slots: { city: 'Paris' }
  })
}));

jest.mock('../../../src/core/transformers-classifier.js', () => ({
  classifyContent: jest.fn().mockResolvedValue({
    content_type: 'travel',
    confidence: 0.9
  })
}));

jest.mock('../../../src/core/ner-enhanced.js', () => ({
  extractEntitiesEnhanced: jest.fn().mockResolvedValue({
    locations: [{ text: 'Paris', score: 0.95 }],
    dates: [],
    durations: [],
    money: []
  })
}));

jest.mock('../../../src/core/blend.js', () => ({
  blendWithFacts: jest.fn().mockResolvedValue({
    reply: 'Weather in Paris is sunny today.',
    citations: ['Weather API']
  })
}));

jest.mock('../../../src/core/slot_memory.js', () => ({
  getThreadSlots: jest.fn().mockReturnValue({}),
  updateThreadSlots: jest.fn(),
  setLastIntent: jest.fn(),
  getLastIntent: jest.fn(),
  normalizeSlots: jest.fn((prior, extracted) => ({ ...prior, ...extracted })),
  readConsentState: jest.fn().mockReturnValue({ awaiting: false, type: '', pending: '' }),
  writeConsentState: jest.fn()
}));

jest.mock('../../../src/core/graph.optimizers.js', () => ({
  checkYesNoShortcut: jest.fn().mockReturnValue(null),
  checkPolicyHit: jest.fn().mockReturnValue(false),
  checkWebishHit: jest.fn().mockReturnValue(false),
  buildTurnCache: jest.fn().mockResolvedValue({
    msgRaw: 'Paris weather today',
    msgL: 'paris weather today',
    words: new Set(['paris', 'weather', 'today'])
  }),
  maybeFastWeather: jest.fn().mockResolvedValue({
    next: 'weather',
    slots: { city: 'Paris' }
  })
}));

jest.mock('../../../src/core/clarifier.js', () => ({
  buildClarifyingQuestion: jest.fn().mockResolvedValue('Which city are you asking about?')
}));

describe('Optimized Graph', () => {
  const logger = pinoLib({ level: 'silent' });
  const ctx = { log: logger };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle fast-path weather queries', async () => {
    const result = await runGraphTurn('Paris weather today', 'test-thread', ctx);
    
    // Deterministic assertions first
    expect(result.done).toBe(true);
    expect(result.reply).toBeTruthy();
    expect(typeof result.reply).toBe('string');
    
    // Then check specific content
    expect(result).toEqual({
      done: true,
      reply: 'Weather in Paris is sunny today.',
      citations: ['Weather API']
    });
  });

  it('should log metrics for performance tracking', async () => {
    const logSpy = jest.spyOn(logger, 'debug');
    
    await runGraphTurn('Paris weather today', 'test-thread', ctx);
    
    // Should log completion metrics
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.any(String),
        llmCallsThisTurn: expect.any(Number),
        slotsCount: expect.any(Number)
      }),
      'graph_turn_complete'
    );
  });
});
