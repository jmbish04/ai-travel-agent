/**
 * Integration test for mixed language processing
 * Tests blendWithFacts warning and has_mixed_languages flag
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { blendWithFacts } from '../../src/core/blend.js';
import { createLogger } from '../../src/util/logging.js';

// Mock language detection to return mixed languages
jest.mock('../../src/core/transformers-classifier.js', () => ({
  detectLanguages: jest.fn().mockResolvedValue([
    { language: 'en', confidence: 0.6 },
    { language: 'ru', confidence: 0.4 }
  ])
}));

describe('Mixed Language Flow', () => {
  const logger = createLogger();
  const ctx = { log: logger };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should detect mixed languages and set warning flag', async () => {
    const result = await blendWithFacts(
      'Hello мир, weather in Москва today?',
      'weather',
      { city: 'Moscow' },
      [],
      'test-thread',
      ctx
    );

    // Should return warning about mixed languages
    expect(result.reply).toMatch(/language|mixed|english/i);
    expect(result.has_mixed_languages).toBe(true);
  });

  test('should handle Cyrillic script detection', async () => {
    const result = await blendWithFacts(
      'Погода в Париже сегодня?',
      'weather',
      { city: 'Paris' },
      [],
      'test-thread',
      ctx
    );

    // Should detect non-Latin script
    expect(result.reply).toMatch(/language|english/i);
    expect(result.has_mixed_languages).toBe(true);
  });

  test('should pass through pure English queries', async () => {
    // Mock pure English detection
    const { detectLanguages } = await import('../../src/core/transformers-classifier.js');
    jest.mocked(detectLanguages).mockResolvedValueOnce([
      { language: 'en', confidence: 0.95 }
    ]);

    const result = await blendWithFacts(
      'Weather in Paris today?',
      'weather',
      { city: 'Paris' },
      [],
      'test-thread',
      ctx
    );

    // Should not have mixed language warning
    expect(result.has_mixed_languages).toBeFalsy();
    expect(result.reply).not.toMatch(/language|mixed/i);
  });
});
