import { describe, test, expect } from '@jest/globals';
import {
  areIntentsRelated,
  getContextTransition,
  calculateContextRelevance,
  getSlotsToPreserve,
  clearWorkflowState,
  SLOT_CATEGORIES
} from '../src/core/context_manager.js';

describe('Context Manager', () => {
  test('identifies related intents correctly', () => {
    expect(areIntentsRelated('weather', 'packing')).toBe(true);
    expect(areIntentsRelated('flights', 'irrops')).toBe(true);
    expect(areIntentsRelated('weather', 'flights')).toBe(false);
    expect(areIntentsRelated('weather', 'weather')).toBe(true);
  });

  test('calculates context relevance scores', () => {
    // User preferences always relevant
    expect(calculateContextRelevance('passengers', 'flights', 'weather', '2')).toBe(0.95);
    
    // Workflow state never relevant across intents
    expect(calculateContextRelevance('awaiting_web_search_consent', 'flights', 'weather', 'true')).toBe(0.0);
    
    // Same intent - high relevance
    expect(calculateContextRelevance('originCity', 'flights', 'flights', 'Paris')).toBe(0.9);
    
    // Related intents with explicit preservation
    expect(calculateContextRelevance('city', 'weather', 'packing', 'Rome')).toBe(0.8);
    
    // Unrelated intents - low relevance
    const relevance = calculateContextRelevance('originCity', 'flights', 'weather', 'Paris');
    expect(relevance).toBeLessThan(0.3);
  });

  test('preserves correct slots during intent transitions', () => {
    const flightSlots = {
      originCity: 'Berlin',
      destinationCity: 'Paris', 
      departureDate: 'tomorrow',
      passengers: '2',
      cabinClass: 'business'
    };
    
    // Flight to weather - should preserve user preferences only
    const preserved = getSlotsToPreserve(flightSlots, 'flights', 'weather');
    expect(preserved).toEqual({
      passengers: '2',
      cabinClass: 'business'
    });
  });

  test('clears workflow state slots', () => {
    const slots = {
      city: 'Paris',
      awaiting_web_search_consent: 'true',
      pending_search_query: 'test',
      passengers: '2'
    };
    
    const cleaned = clearWorkflowState(slots);
    expect(cleaned).toEqual({
      city: 'Paris',
      passengers: '2'
    });
  });

  test('handles weather to packing context transition', () => {
    const weatherSlots = {
      city: 'Rome',
      month: 'December',
      dates: 'December 2025',
      awaiting_web_search_consent: 'true'
    };
    
    const preserved = getSlotsToPreserve(weatherSlots, 'weather', 'packing');
    expect(preserved.city).toBe('Rome');
    expect(preserved.month).toBe('December');
    expect(preserved.dates).toBe('December 2025');
    expect(preserved.awaiting_web_search_consent).toBeUndefined();
  });

  test('slot categorization is complete', () => {
    const allSlots = [
      ...SLOT_CATEGORIES.userPreferences,
      ...SLOT_CATEGORIES.intentSpecific,
      ...SLOT_CATEGORIES.workflowState,
      ...SLOT_CATEGORIES.conversationContext
    ];
    
    // Verify no duplicates
    const uniqueSlots = new Set(allSlots);
    expect(uniqueSlots.size).toBe(allSlots.length);
    
    // Verify key slots are categorized
    expect(SLOT_CATEGORIES.userPreferences).toContain('passengers');
    expect(SLOT_CATEGORIES.intentSpecific).toContain('originCity');
    expect(SLOT_CATEGORIES.workflowState).toContain('awaiting_web_search_consent');
    expect(SLOT_CATEGORIES.conversationContext).toContain('last_search_query');
  });
});
