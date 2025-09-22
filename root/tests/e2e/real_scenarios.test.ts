import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { handleChat } from '../../src/core/blend.js';
import { createLogger } from '../../src/util/logging.js';
import { expectLLMEvaluation } from '../../src/test/llm-evaluator.js';
import nock from 'nock';

// Configure nock
nock.disableNetConnect();
nock.enableNetConnect((host) => {
  if (host.includes('127.0.0.1') || host.includes('localhost')) return true;
  if (host.includes('openrouter.ai')) return true;
  if (host.includes('api.open-meteo.com')) return true;
  if (host.includes('geocoding-api.open-meteo.com')) return true;
  if (host.includes('restcountries.com')) return true;
  if (host.includes('api.opentripmap.com')) return true;
  if (host.includes('api.search.brave.com')) return true;
  return false;
});

describe('Real User Scenarios E2E', () => {
  const log = createLogger();

  afterEach(() => {
    nock.cleanAll();
  });

  // Simple test first
  it('should respond to basic query', async () => {
    const result = await handleChat({ message: 'hello', threadId: 'test-thread' }, { log });
    console.log('Test result:', result);
    
    expect(result).toBeDefined();
    expect(result.reply).toBeDefined();
  }, 30000);

  const testCases = [
    // Weather queries
    {
      query: 'Weather in Paris today?',
      description: 'Weather query for Paris today',
      criteria: 'Response should provide weather information for Paris with temperature and conditions from a reliable weather service.'
    },
    {
      query: 'Weather in Madrid',
      description: 'Weather query for Madrid',
      criteria: 'Response should provide weather information for Madrid with temperature and conditions.'
    },
    {
      query: 'Weather in Paris this week?',
      description: 'Weekly weather forecast for Paris',
      criteria: 'Response should provide weather information for Paris, may be current conditions or forecast data.'
    },
    
    // Packing queries
    {
      query: 'What to pack for Rome in December?',
      description: 'Packing advice for Rome in winter',
      criteria: 'Response should provide packing advice for Rome, considering weather conditions and appropriate clothing.'
    },
    {
      query: 'What should I pack for Iceland in winter?',
      description: 'Packing advice for Iceland winter',
      criteria: 'Response should provide winter packing advice for Iceland, considering cold weather and appropriate gear.'
    },
    {
      query: 'Packing for Thailand in summer',
      description: 'Packing advice for Thailand summer',
      criteria: 'Response should provide summer packing advice for Thailand, considering hot tropical weather.'
    },
    
    // Attractions queries
    {
      query: 'Kid-friendly things to do in London',
      description: 'Family activities in London',
      criteria: 'Response should suggest family-friendly activities, attractions, or experiences suitable for children in London.'
    },
    {
      query: 'Attractions there for families',
      description: 'Family attractions query',
      criteria: 'Response should ask for clarification about location or provide general family attraction advice.'
    },
    {
      query: 'Attractions in Amsterdam',
      description: 'Amsterdam attractions',
      criteria: 'Response should provide information about tourist attractions and things to do in Amsterdam.'
    },
    
    // Destination queries
    {
      query: 'Tell me about Paris',
      description: 'General information about Paris',
      criteria: 'Response should either provide information about Paris or ask for more specific travel details.'
    },
    {
      query: 'Tell me about destinations in Asia',
      description: 'Asian destinations overview',
      criteria: 'Response should either provide information about Asian destinations or offer to search for specific information.'
    },
    
    // Flight queries
    {
      query: 'Find flights there from Berlin tomorrow',
      description: 'Flight search with missing destination',
      criteria: 'Response should ask for clarification about the destination or offer to help with flight search.'
    },
    {
      query: 'Flights from Berlin to London tomorrow?',
      description: 'Flight search Berlin to London',
      criteria: 'Response should provide flight search results or information about flights from Berlin to London.'
    },
    {
      query: 'From NYC, end of June (last week), 4-5 days. 2 adults + toddler in stroller. Parents mid - 60s; dad dislikes long flights. Budget under $2.5k total. Ideas?',
      description: 'Complex travel planning query',
      criteria: 'Response should acknowledge the travel constraints and either provide suggestions or ask for clarification.'
    },
    
    // Policy queries
    {
      query: 'What are the change fees for JetBlue flights? Get me the official policy with receipts.',
      description: 'JetBlue change fee policy',
      criteria: 'Response should either provide policy information, offer to search for it, or explain limitations in accessing current policy data.'
    },
    {
      query: 'What is El Al\'s carry-on baggage size limit? I need the exact policy with receipts.',
      description: 'El Al baggage policy',
      criteria: 'Response should either provide baggage policy information, offer to search for it, or explain limitations in accessing current policy data.'
    },
    {
      query: 'What is the timeframe for Delta\'s risk-free cancellation policy and what are the key conditions?',
      description: 'Delta cancellation policy',
      criteria: 'Response should either provide policy information, offer to search for it, or explain limitations in accessing current policy data.'
    },
    {
      query: 'What are the change fees for Aeroflot flights? Get me the official policy with receipts.',
      description: 'Aeroflot change fee policy',
      criteria: 'Response should either provide policy information, offer to search for it, or explain limitations in accessing current policy data.'
    },
    
    // Disruption handling
    {
      query: 'My flight DL8718 from CDG to LHR was cancelled, please help me rebook',
      description: 'Flight cancellation assistance',
      criteria: 'Response should acknowledge the cancellation and either provide rebooking guidance or direct to appropriate resources.'
    },
    
    // Hotel queries
    {
      query: 'Best hotels there right now',
      description: 'Hotel search with missing location',
      criteria: 'Response should ask for clarification about the location or explain limitations in providing hotel recommendations.'
    },
    
    // Travel restrictions
    {
      query: 'Latest travel restrictions for Germany',
      description: 'Germany travel restrictions',
      criteria: 'Response should either provide travel restriction information, offer to search for current information, or explain limitations in accessing latest data.'
    },
    
    // Events and festivals
    {
      query: 'Please search for any festivals or events that week we should plan around California.',
      description: 'California events search',
      criteria: 'Response should either ask for clarification about the specific week, offer to search for events, or explain limitations in accessing event data.'
    },
    
    // Complex multi-part queries
    {
      query: 'Tell me about visa for German passport to China then weather in Berlin',
      description: 'Multi-part visa and weather query',
      criteria: 'Response should address at least one part of the query (visa or weather) or ask for clarification about which to prioritize.'
    },
    {
      query: 'Random stuff then weather in London',
      description: 'Mixed query with weather request',
      criteria: 'Response should focus on the weather in London part and ignore or clarify the unclear "random stuff" portion.'
    },
  ];

  testCases.forEach(({ query, description, criteria }) => {
    it(`should handle: "${query}"`, async () => {
      const result = await handleChat({ message: query, threadId: 'test-thread' }, { log });
      
      // Basic assertions
      expect(result).toBeDefined();
      expect(result.reply).toBeDefined();
      expect(result.reply.length).toBeGreaterThan(20);
      expect(result.reply.length).toBeLessThan(5000);
      
      // LLM-based evaluation
      await expectLLMEvaluation(
        description,
        result.reply,
        criteria,
        0.7 // 70% confidence threshold
      ).toPass();
      
    }, 60000); // 60s timeout
  });

  // Nonsense/unclear queries
  const unclearQueries = [
    'hmm maybe something weird',
    'xyz abc random stuff', 
    'blah blah nonsense'
  ];

  unclearQueries.forEach((query) => {
    it(`should handle unclear query: "${query}"`, async () => {
      const result = await handleChat({ message: query, threadId: 'test-thread' }, { log });
      
      expect(result).toBeDefined();
      expect(result.reply).toBeDefined();
      
      await expectLLMEvaluation(
        'Unclear/nonsense query handling',
        result.reply,
        'Response should politely indicate that the query is unclear or ask for clarification. Should not provide random travel information.',
        0.6
      ).toPass();
      
    }, 60000);
  });
});
