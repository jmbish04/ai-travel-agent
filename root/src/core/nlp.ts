import type pino from 'pino';
import { z } from 'zod';
import { classifyContent } from './llm.js';

export type Intent = 'weather'|'packing'|'attractions'|'destinations'|'unknown'|'web_search'|'system';
export type ContentType = 'system'|'travel'|'unrelated'|'budget'|'restaurant'|'flight'|'gibberish'|'emoji_only';

export type Slots = {
  city?: string;
  month?: string;
  dates?: string;
  travelerProfile?: string;
  originCity?: string;
  destCity?: string;
  // Internal flags used by graph/blend
  awaiting_search_consent?: string;
  pending_search_query?: string;
};

// Intentionally trimmed: routing handled elsewhere

const ContentClassification = z.object({
  content_type: z.union([
    z.literal('system'),
    z.literal('travel'),
    z.literal('unrelated'),
    z.literal('budget'),
    z.literal('restaurant'),
    z.literal('flight'),
    z.literal('gibberish'),
    z.literal('emoji_only'),
  ]),
  is_explicit_search: z.boolean(),
  has_mixed_languages: z.boolean().optional().default(false),
  needs_web_search: z.boolean().optional().default(false),
  confidence: z.number().min(0).max(1).optional().default(0.6),
});
export type ContentClassificationT = z.infer<typeof ContentClassification>;

// Redirect to unified implementation
export const classifyContentLLM = classifyContent;

/**
 * Detect intent and slots for a user message using an LLM-first cascade.
 * Falls back to deterministic parsers when the LLM path is unavailable.
 */
// Removed overlapping intent/slot detection to avoid duplication with router/parsers.
