import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import pino from 'pino';
import { runGraphTurn } from '../../../src/core/graph.js';

const clarifierMock = jest.fn();

jest.mock('../../../src/core/router.js', () => ({
  routeIntent: jest.fn().mockResolvedValue({
    intent: 'packing',
    confidence: 0.92,
    slots: { city: 'Paris' },
  }),
}));

jest.mock('../../../src/core/transformers-classifier.js', () => ({
  classifyContent: jest.fn().mockResolvedValue({
    content_type: 'travel',
    confidence: 0.94,
  }),
}));

jest.mock('../../../src/core/ner-enhanced.js', () => ({
  extractEntitiesEnhanced: jest.fn().mockResolvedValue({
    locations: [],
    dates: [],
    durations: [],
    money: [],
  }),
}));

jest.mock('../../../src/core/blend.js', () => ({
  blendWithFacts: jest.fn().mockResolvedValue({
    reply: 'Paris — today: Weather: High 22C / Low 15C (Open-Meteo)\nPack: light layers',
    citations: ['Open-Meteo'],
  }),
}));

jest.mock('../../../src/core/slot_memory.js', () => ({
  getThreadSlots: jest.fn().mockReturnValue({}),
  updateThreadSlots: jest.fn(),
  setLastIntent: jest.fn(),
  getLastIntent: jest.fn(),
  normalizeSlots: jest.fn((_prior, extracted) => ({ ...extracted })),
  readConsentState: jest.fn().mockReturnValue({ awaiting: false, type: '', pending: '' }),
  writeConsentState: jest.fn(),
}));

jest.mock('../../../src/core/graph.optimizers.js', () => ({
  checkYesNoShortcut: jest.fn().mockReturnValue(null),
  checkPolicyHit: jest.fn().mockReturnValue(false),
  checkWebishHit: jest.fn().mockReturnValue(false),
  buildTurnCache: jest.fn().mockResolvedValue({
    msgRaw: 'What should I pack to Paris?',
    msgL: 'what should i pack to paris?',
    words: new Set(['what', 'should', 'i', 'pack', 'to', 'paris?']),
  }),
  maybeFastWeather: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../../src/core/clarifier.js', () => ({
  buildClarifyingQuestion: clarifierMock,
}));

describe('Packing clarifier behaviour', () => {
  const logger = pino({ level: 'silent' });
  const ctx = { log: logger };

  beforeEach(() => {
    clarifierMock.mockClear();
  });

  it('does not request dates when city is provided for packing intent', async () => {
    const result = await runGraphTurn('What should I pack to Paris?', 'packing-thread', ctx);

    expect(result.done).toBe(true);
    expect(result.reply).toContain('Pack');
    expect(clarifierMock).not.toHaveBeenCalled();
  });
});
