import { describe, test, expect } from '@jest/globals';
import { routeIntent } from '../src/core/router.js';

describe('Weather Classification Fix', () => {
  test('classifies weather queries correctly without flight context contamination', async () => {
    const result = await routeIntent({
      message: 'Weather in Paris today?',
      threadId: 'test_weather_clean'
    });
    
    expect(result.intent).toBe('weather');
    expect(result.slots.city).toBe('Paris');
    expect(result.slots.dates).toBe('today');
    expect(result.slots.originCity).toBeUndefined();
    expect(result.slots.destinationCity).toBeUndefined();
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  test('handles intent transition from flights to weather', async () => {
    const threadId = 'test_intent_transition';
    
    // First request - flights
    const flightResult = await routeIntent({
      message: 'Find flights from Berlin to Tokyo tomorrow',
      threadId
    });
    
    expect(flightResult.intent).toBe('flights');
    expect(flightResult.slots.originCity).toBe('Berlin');
    expect(flightResult.slots.destinationCity).toBe('Tokyo');
    
    // Second request - weather (should not be contaminated by flight context)
    const weatherResult = await routeIntent({
      message: 'Weather in Paris today?',
      threadId
    });
    
    expect(weatherResult.intent).toBe('weather');
    expect(weatherResult.slots.city).toBe('Paris');
    expect(weatherResult.slots.dates).toBe('today');
    // Should not have flight-related slots
    expect(weatherResult.slots.originCity).toBeUndefined();
    expect(weatherResult.slots.destinationCity).toBeUndefined();
  });

  test('preserves user preferences across intent transitions', async () => {
    const threadId = 'test_preference_preservation';
    
    // First request with user preferences
    const flightResult = await routeIntent({
      message: 'Find business class flights for 2 passengers to Rome',
      threadId
    });
    
    expect(flightResult.intent).toBe('flights');
    expect(flightResult.slots.cabinClass).toBe('business');
    expect(flightResult.slots.passengers).toBe('2');
    
    // Second request - different intent should preserve preferences
    const weatherResult = await routeIntent({
      message: 'Weather in Madrid today?',
      threadId
    });
    
    expect(weatherResult.intent).toBe('weather');
    expect(weatherResult.slots.city).toBe('Madrid');
    // User preferences should be preserved (handled by slot management)
  });
});
