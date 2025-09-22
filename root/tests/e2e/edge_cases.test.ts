import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import { router } from '../../src/api/routes.js';
import { chat } from '../helpers.js';
import { expectLLMEvaluation } from '../../src/test/llm-evaluator.js';

describe('Edge Cases E2E', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/', router);
  });
  describe('Incomplete Location Queries', () => {
    const incompleteLocationCases = [
      {
        query: 'Weather there',
        description: 'Weather query without location',
        criteria: 'Response should ask for clarification about which location the user wants weather information for.'
      },
      {
        query: 'What to pack for there?',
        description: 'Packing query without destination',
        criteria: 'Response should ask for clarification about the destination to provide appropriate packing advice.'
      },
      {
        query: 'Attractions in that place',
        description: 'Attractions query with vague location reference',
        criteria: 'Response should ask for clarification about which specific place or city the user is interested in.'
      },
      {
        query: 'Flights to there tomorrow',
        description: 'Flight query without destination',
        criteria: 'Response should ask for clarification about the destination and departure city for flight search.'
      },
      {
        query: 'Hotels in the city',
        description: 'Hotel query with generic city reference',
        criteria: 'Response should ask which specific city the user is looking for hotel recommendations in.'
      }
    ];

    incompleteLocationCases.forEach(({ query, description, criteria }) => {
      it(`should handle: "${query}"`, async () => {
        const result = await chat(app, query, 'test-thread');
        
        expect(result).toBeDefined();
        expect(result.reply).toBeDefined();
        
        await expectLLMEvaluation(description, result.reply!, criteria, 0.7).toPass();
      }, 30000);
    });
  });

  describe('Missing Origin/Destination Queries', () => {
    const missingOriginDestinationCases = [
      {
        query: 'Flights to London',
        description: 'Flight query missing origin',
        criteria: 'Response should ask for clarification about the departure city or origin for the flight to London.'
      },
      {
        query: 'Flights from Berlin',
        description: 'Flight query missing destination',
        criteria: 'Response should ask for clarification about the destination city for flights departing from Berlin.'
      },
      {
        query: 'How long is the flight?',
        description: 'Flight duration query without route',
        criteria: 'Response should ask for clarification about which specific flight route the user is asking about.'
      },
      {
        query: 'What time does my flight leave?',
        description: 'Flight time query without flight details',
        criteria: 'Response should ask for flight number, airline, or route information to provide departure time.'
      },
      {
        query: 'Is there a direct flight?',
        description: 'Direct flight query without route',
        criteria: 'Response should ask for clarification about the origin and destination cities to check for direct flights.'
      }
    ];

    missingOriginDestinationCases.forEach(({ query, description, criteria }) => {
      it(`should handle: "${query}"`, async () => {
        const result = await chat(app, query, 'test-thread');
        
        expect(result).toBeDefined();
        expect(result.reply!).toBeDefined();
        
        await expectLLMEvaluation(description, result.reply!, criteria, 0.7).toPass();
      }, 30000);
    });
  });

  describe('Unclear Intent Queries', () => {
    const unclearIntentCases = [
      {
        query: 'Help me with travel',
        description: 'Generic travel help request',
        criteria: 'Response should ask for more specific information about what kind of travel assistance is needed.'
      },
      {
        query: 'I need information',
        description: 'Vague information request',
        criteria: 'Response should ask for clarification about what specific travel information is needed.'
      },
      {
        query: 'Can you help?',
        description: 'Generic help request',
        criteria: 'Response should explain available travel assistance capabilities and ask what specific help is needed.'
      },
      {
        query: 'Something about Europe',
        description: 'Vague Europe-related query',
        criteria: 'Response should ask for clarification about what specific information about Europe is needed (weather, attractions, travel, etc.).'
      },
      {
        query: 'Tell me stuff',
        description: 'Extremely vague request',
        criteria: 'Response should ask for clarification about what specific travel-related information the user wants.'
      }
    ];

    unclearIntentCases.forEach(({ query, description, criteria }) => {
      it(`should handle: "${query}"`, async () => {
        const result = await chat(app, query, 'test-thread');
        
        expect(result).toBeDefined();
        expect(result.reply!).toBeDefined();
        
        await expectLLMEvaluation(description, result.reply!, criteria, 0.6).toPass();
      }, 30000);
    });
  });

  describe('Ambiguous Time References', () => {
    const ambiguousTimeCases = [
      {
        query: 'Weather tomorrow',
        description: 'Weather query without location',
        criteria: 'Response should ask for location clarification while acknowledging the time reference (tomorrow).'
      },
      {
        query: 'Flights next week',
        description: 'Flight query with time but no route',
        criteria: 'Response should ask for origin and destination while acknowledging the time frame (next week).'
      },
      {
        query: 'What should I pack for next month?',
        description: 'Packing query with time but no destination',
        criteria: 'Response should ask for destination and potentially more specific dates to provide appropriate packing advice.'
      },
      {
        query: 'Events this weekend',
        description: 'Events query without location',
        criteria: 'Response should ask for location clarification to find events happening this weekend.'
      }
    ];

    ambiguousTimeCases.forEach(({ query, description, criteria }) => {
      it(`should handle: "${query}"`, async () => {
        const result = await chat(app, query, 'test-thread');
        
        expect(result).toBeDefined();
        expect(result.reply!).toBeDefined();
        
        await expectLLMEvaluation(description, result.reply!, criteria, 0.7).toPass();
      }, 30000);
    });
  });

  describe('Partial Context Queries', () => {
    const partialContextCases = [
      {
        query: 'Is it cold?',
        description: 'Weather condition query without location or time',
        criteria: 'Response should ask for clarification about location and potentially time frame for weather information.'
      },
      {
        query: 'Do I need a visa?',
        description: 'Visa query without nationality or destination',
        criteria: 'Response should ask for clarification about passport/nationality and destination country for visa requirements.'
      },
      {
        query: 'How much does it cost?',
        description: 'Cost query without context',
        criteria: 'Response should ask for clarification about what specific travel cost is being asked about (flights, hotels, etc.).'
      },
      {
        query: 'Is it safe?',
        description: 'Safety query without location',
        criteria: 'Response should ask for clarification about which destination or location the safety question refers to.'
      },
      {
        query: 'What language do they speak?',
        description: 'Language query without country/location',
        criteria: 'Response should ask for clarification about which country or region the language question refers to.'
      }
    ];

    partialContextCases.forEach(({ query, description, criteria }) => {
      it(`should handle: "${query}"`, async () => {
        const result = await chat(app, query, 'test-thread');
        
        expect(result).toBeDefined();
        expect(result.reply!).toBeDefined();
        
        await expectLLMEvaluation(description, result.reply!, criteria, 0.7).toPass();
      }, 30000);
    });
  });

  describe('Mixed Language and Typos', () => {
    const mixedLanguageTypoCases = [
      {
        query: 'Wether in Pariz?',
        description: 'Weather query with typos',
        criteria: 'Response should understand the intent (weather in Paris) despite spelling errors and provide weather information.'
      },
      {
        query: 'Flihts to Londn tommorow',
        description: 'Flight query with multiple typos',
        criteria: 'Response should understand the intent (flights to London tomorrow) despite spelling errors and provide flight information or ask for origin.'
      },
      {
        query: 'Que tiempo hace en Madrid?',
        description: 'Spanish weather query',
        criteria: 'Response should understand this is a weather query for Madrid and provide weather information, potentially in English or Spanish.'
      },
      {
        query: 'Attractions in Pris France',
        description: 'Attractions query with location typo',
        criteria: 'Response should understand this refers to Paris, France and provide attraction information despite the typo.'
      }
    ];

    mixedLanguageTypoCases.forEach(({ query, description, criteria }) => {
      it(`should handle: "${query}"`, async () => {
        const result = await chat(app, query, 'test-thread');
        
        expect(result).toBeDefined();
        expect(result.reply!).toBeDefined();
        
        await expectLLMEvaluation(description, result.reply!, criteria, 0.6).toPass();
      }, 30000);
    });
  });
});
