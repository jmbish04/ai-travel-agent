import { z } from 'zod';

export const Intent = z.enum(['destinations', 'packing', 'attractions', 'weather', 'policy', 'flights', 'irrops', 'unknown', 'web_search', 'system']);

export const RouterSlots = z.object({
  city: z.string().nullable().optional(),
  originCity: z.string().nullable().optional(),
  destinationCity: z.string().nullable().optional(),
  month: z.string().nullable().optional(),
  dates: z.string().nullable().optional(),
  departureDate: z.string().nullable().optional(),
  returnDate: z.string().nullable().optional(),
  passengers: z.string().nullable().optional(),
  cabinClass: z.string().nullable().optional(),
  travelerProfile: z.string().nullable().optional(),
  search_query: z.string().nullable().optional(),
  // IRROPS-specific slots
  recordLocator: z.string().nullable().optional(),
  disruptionType: z.string().nullable().optional(),
  affectedSegments: z.string().nullable().optional(),
  maxPriceIncrease: z.string().nullable().optional(),
  preferredCarriers: z.string().nullable().optional(),
  minConnectionTime: z.string().nullable().optional(),
  // Deep research consent flow (optional)
  awaiting_deep_research_consent: z.string().nullable().optional(),
  pending_deep_research_query: z.string().nullable().optional(),
  complexity_reasoning: z.string().nullable().optional(),
  deep_research_consent_needed: z.string().nullable().optional(),
  complexity_score: z.string().nullable().optional(),
  // Flight clarification flow (optional)
  flight_clarification_needed: z.string().nullable().optional(),
  ambiguity_reason: z.string().nullable().optional(),
  clarification_options: z.string().nullable().optional(),
  awaiting_flight_clarification: z.string().nullable().optional(),
  pending_flight_query: z.string().nullable().optional(),
  clarification_reasoning: z.string().nullable().optional(),
});

export const RouterResult = z.object({
  intent: Intent,
  needExternal: z.boolean(),
  slots: RouterSlots,
  confidence: z.number().min(0).max(1).optional().default(0.8),
});

export type RouterResultT = z.infer<typeof RouterResult>;
