/**
 * Context and slot management system for intelligent context transitions
 */

export interface SlotCategories {
  userPreferences: string[];     // Persist across intents
  intentSpecific: string[];      // Clear on intent change
  workflowState: string[];       // Clear immediately after use
  conversationContext: string[]; // Decay over time
}

export interface ContextTransition {
  fromIntent: string;
  toIntent: string;
  preserveSlots: string[];
  clearSlots: string[];
  transformSlots: Record<string, string>;
}

/**
 * Slot categorization based on lifecycle and scope
 */
export const SLOT_CATEGORIES: SlotCategories = {
  userPreferences: [
    'passengers',
    'cabinClass', 
    'travelerProfile'
  ],
  
  intentSpecific: [
    'originCity',
    'destinationCity', 
    'city',
    'flightNumber',
    'dates',
    'departureDate',
    'returnDate',
    'month',
    'region'
  ],
  
  workflowState: [
    'awaiting_search_consent',
    'awaiting_deep_research_consent',
    'awaiting_web_search_consent',
    'pending_search_query',
    'pending_deep_research_query', 
    'pending_web_search_query',
    'amadeus_failed',
    'flight_clarification_needed',
    'awaiting_flight_clarification'
  ],
  
  conversationContext: [
    'last_search_query',
    'recordLocator',
    'disruptionType'
  ]
};

/**
 * Intent relationship mapping for context preservation
 */
export const INTENT_RELATIONSHIPS: Record<string, string[]> = {
  // Minimal allowlist for proven transitions
  weather: ['packing', 'attractions'],
  packing: ['weather', 'attractions'],
  attractions: ['weather', 'packing'],
  flights: ['irrops'],
  irrops: ['flights'],
  // Other intents do not imply preservation by default
  destinations: [],
  policy: [],
  web_search: [],
  system: [],
  unknown: []
};

/**
 * Context transition rules for different intent combinations
 */
export const CONTEXT_TRANSITIONS: ContextTransition[] = [
  // Weather to related intents - preserve location context
  {
    fromIntent: 'weather',
    toIntent: 'packing',
    preserveSlots: ['city', 'month', 'dates'],
    clearSlots: [],
    transformSlots: {}
  },
  {
    fromIntent: 'weather', 
    toIntent: 'attractions',
    preserveSlots: ['city'],
    clearSlots: ['month', 'dates'],
    transformSlots: {}
  },
  
  // Flights to IRROPS - preserve flight context
  {
    fromIntent: 'flights',
    toIntent: 'irrops', 
    preserveSlots: ['originCity', 'destinationCity', 'departureDate'],
    clearSlots: [],
    transformSlots: {}
  },
  
  // Unrelated intent transitions - clear intent-specific slots
  {
    fromIntent: 'flights',
    toIntent: 'weather',
    preserveSlots: [],
    clearSlots: ['originCity', 'destinationCity', 'departureDate', 'returnDate'],
    transformSlots: {}
  },
  {
    fromIntent: 'weather',
    toIntent: 'flights', 
    preserveSlots: [],
    clearSlots: ['city', 'month', 'dates'],
    transformSlots: {}
  }
];

/**
 * Determine if two intents are related based on context sharing
 */
export function areIntentsRelated(fromIntent: string, toIntent: string): boolean {
  return INTENT_RELATIONSHIPS[fromIntent]?.includes(toIntent) || 
         INTENT_RELATIONSHIPS[toIntent]?.includes(fromIntent) ||
         fromIntent === toIntent;
}

/**
 * Get context transition rules for intent change
 */
export function getContextTransition(fromIntent: string, toIntent: string): ContextTransition | null {
  return CONTEXT_TRANSITIONS.find(t => 
    t.fromIntent === fromIntent && t.toIntent === toIntent
  ) || null;
}

/**
 * Calculate context relevance score for slot preservation
 */
export function calculateContextRelevance(
  slot: string,
  fromIntent: string, 
  toIntent: string,
  slotValue: string,
  ageMinutes: number = 0
): number {
  // User preferences always relevant
  if (SLOT_CATEGORIES.userPreferences.includes(slot)) {
    return 0.95;
  }
  
  // Workflow state never relevant across intents
  if (SLOT_CATEGORIES.workflowState.includes(slot)) {
    return 0.0;
  }
  
  // Same intent - high relevance
  if (fromIntent === toIntent) {
    return 0.9;
  }
  
  // Related intents - check specific slot relevance
  if (areIntentsRelated(fromIntent, toIntent)) {
    const transition = getContextTransition(fromIntent, toIntent);
    if (transition?.preserveSlots.includes(slot)) {
      return 0.8;
    }
    if (transition?.clearSlots.includes(slot)) {
      return 0.0;
    }
    return 0.6; // Default for related intents
  }
  
  // Unrelated intents - low relevance with time decay
  const baseRelevance = 0.2;
  const timeDecay = Math.max(0, 1 - (ageMinutes / 60)); // Decay over 1 hour
  return baseRelevance * timeDecay;
}

/**
 * Determine which slots to preserve during intent transition
 */
export function getSlotsToPreserve(
  currentSlots: Record<string, string>,
  fromIntent: string,
  toIntent: string
): Record<string, string> {
  const preservedSlots: Record<string, string> = {};
  
  for (const [slot, value] of Object.entries(currentSlots)) {
    const relevance = calculateContextRelevance(slot, fromIntent, toIntent, value);
    
    if (relevance >= 0.7) {
      preservedSlots[slot] = value;
    }
  }
  
  return preservedSlots;
}

/**
 * Clean workflow state slots that should be cleared immediately
 */
export function clearWorkflowState(slots: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(slots)) {
    if (!SLOT_CATEGORIES.workflowState.includes(key)) {
      cleaned[key] = value;
    }
  }
  
  return cleaned;
}
