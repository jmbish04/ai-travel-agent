import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { configureNock, createTestApp, createRecorderIfEnabled, makeRequest, recordedRequest, TranscriptRecorder, nock } from './_setup.js';
import { assertWithLLMOrSkip, mockExternalApis } from '../helpers.js';
import express from 'express';

configureNock();
process.env.NODE_ENV = 'test';

describe('E2E: Weather & Packing', () => {
  let app: express.Express;
  let transcriptRecorder: TranscriptRecorder | undefined;

  beforeAll(() => {
    transcriptRecorder = createRecorderIfEnabled();
    if (transcriptRecorder) console.log('📝 Transcript saving enabled');
    else console.log('📝 Transcript saving disabled (use --save-transcripts to enable)');
  });

  afterAll(async () => {
    if (transcriptRecorder) {
      await transcriptRecorder.saveTranscripts();
      console.log('💾 Transcripts saved to deliverables/transcripts/');
    }
  });

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('🌍 Basic Weather & City Queries', () => {
    test('handles standard weather query', async () => {
      await mockExternalApis({ weatherFixture: 'berlin' });

      const r = await recordedRequest(app, transcriptRecorder, 'standard_weather_query', 'What is the weather like in Berlin?');
      
      // Deterministic assertions first
      expect(r.body.reply).toBeTruthy();
      expect(typeof r.body.reply).toBe('string');
      expect(r.body.reply.length).toBeGreaterThan(10);
      
      // Then LLM evaluation if available
      await assertWithLLMOrSkip(
        async () => {
          const { expectLLMEvaluation } = await import('../../src/test/llm-evaluator.js');
          return expectLLMEvaluation(
            'Weather query for Berlin',
            r.body.reply,
            'Response should provide weather information for Berlin'
          ).toPass();
        },
        'Weather query evaluation'
      );
    }, 45000);

    test('handles misspelled cities', async () => {
      await mockExternalApis({ weatherFixture: 'berlin' });

      const r = await recordedRequest(app, transcriptRecorder, 'misspelled_city_query', 'Weather in Berln?');
      
      // Deterministic assertions
      expect(r.body.reply).toBeTruthy();
      expect(r.body.reply).toMatch(/berlin|clarification|spell/i);
      
      await assertWithLLMOrSkip(
        async () => {
          const { expectLLMEvaluation } = await import('../../src/test/llm-evaluator.js');
          return expectLLMEvaluation(
            'Misspelled city query (Berln instead of Berlin)',
            r.body.reply,
            'Response should handle the misspelled city gracefully'
          ).toPass();
        },
        'Misspelled city evaluation'
      );
    }, 45000);

    test('handles packing suggestions', async () => {
      await mockExternalApis({ weatherFixture: 'berlin' });

      const r = await recordedRequest(app, transcriptRecorder, 'packing_suggestions', 'What should I pack for Berlin?');
      
      // Deterministic assertions
      expect(r.body.reply).toBeTruthy();
      expect(r.body.reply).toMatch(/pack|clothing|weather|temperature/i);
      
      await assertWithLLMOrSkip(
        async () => {
          const { expectLLMEvaluation } = await import('../../src/test/llm-evaluator.js');
          return expectLLMEvaluation(
            'Packing suggestions for Berlin',
            r.body.reply,
            'Response should provide relevant packing advice based on weather'
          ).toPass();
        },
        'Packing suggestions evaluation'
      );
    }, 45000);
  });
});
        .query(true)
        .reply(200, { daily: { temperature_2m_max: [28], temperature_2m_min: [18], precipitation_probability_mean: [10] } });

      const r = await recordedRequest(app, transcriptRecorder, 'city_abbreviation_query', 'Weather in NYC in June?');
      await expectLLMEvaluation(
        'City abbreviation query (NYC) with month',
        r.body.reply,
        'Response should understand NYC refers to New York City and provide weather information for June or ask for more specific dates'
      ).toPass();
    }, 45000);
  });

  describe('🎒 Packing Suggestions', () => {
    test('basic packing queries', async () => {
      const r = await recordedRequest(app, transcriptRecorder, 'basic_packing_query', 'What to pack for Paris in June?');
      await expectLLMEvaluation(
        'Packing query for Paris in June',
        r.body.reply,
        'Response should provide packing suggestions appropriate for Paris in June, considering weather and activities'
      ).toPass();
    }, 45000);

    test('packing with special circumstances', async () => {
      const r = await recordedRequest(app, transcriptRecorder, 'packing_with_kids', 'What to pack for Tokyo if I have kids?');
      await expectLLMEvaluation(
        'Packing query for Tokyo with kids',
        r.body.reply,
        'Response should ask for travel dates or provide family-friendly packing suggestions for Tokyo'
      ).toPass();
    }, 45000);
  });
});

