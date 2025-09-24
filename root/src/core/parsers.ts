import { z } from 'zod';
import { callLLM } from './llm.js';
import { getPrompt } from './prompts.js';
import type pino from 'pino';

const CITY_CONF_THRESHOLD = 0.65;
const DATE_CONF_THRESHOLD = 0.60;
const OD_CONF_THRESHOLD = 0.60;

export interface ParseRequest {
  text: string;
  type: 'date' | 'city' | 'intent' | 'slots';
  context?: Record<string, any>;
  language?: 'en' | 'ru' | 'auto';
}

export interface ParseResponse<T = any> {
  success: boolean;
  data: T | null;
  confidence: number;
  normalized?: string;
}

const CityParseResult = z.object({
  city: z.string().optional(),
  country: z.string().optional(),
  normalized: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

type CityParseResultT = z.infer<typeof CityParseResult>;

const DateParseResult = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  month: z.string().optional(),
  dates: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

type DateParseResultT = z.infer<typeof DateParseResult>;

const IntentParseResult = z.object({
  intent: z.enum(['weather', 'destinations', 'packing', 'attractions', 'unknown']),
  confidence: z.number().min(0).max(1),
  slots: z.record(z.string()),
});

const OriginDestinationParseResult = z.object({
  originCity: z.string().optional(),
  destinationCity: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

type OriginDestinationParseResultT = z.infer<typeof OriginDestinationParseResult>;

const IntentDetectionSchema = z.object({
  intent: z.enum(['weather', 'destinations', 'packing', 'attractions', 'flights', 'unknown']),
  confidence: z.number().min(0).max(1),
  needExternal: z.boolean(),
  slots: z.record(z.unknown()).optional().default({}),
});

type IntentDetection = z.infer<typeof IntentDetectionSchema>;

function escapeForPrompt(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function stringifyContext(context?: Record<string, any>): string {
  try {
    return JSON.stringify(context ?? {}, null, 0);
  } catch {
    return '{}';
  }
}

function normalizeSlotValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.length > 0) return value.map((v) => normalizeSlotValue(v)).filter(Boolean).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mergeSlots(target: Record<string, string>, source?: Record<string, string | undefined>): Record<string, string> {
  if (!source) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && !target[key]) {
      target[key] = value;
    }
  }
  return target;
}

export async function detectIntentAndSlots(
  text: string,
  context?: Record<string, any>,
  logger?: pino.Logger,
): Promise<IntentDetection | null> {
  try {
    logger?.debug?.({ 
      text: text.substring(0, 200),
      contextKeys: Object.keys(context || {}),
      contextValues: context
    }, '🔧 PARSERS: Starting intent detection');
    
    const template = await getPrompt('nlp_intent_detection');
    const prompt = template
      .replace('{message}', escapeForPrompt(text))
      .replace('{context}', stringifyContext(context));

    logger?.debug?.({ 
      promptLength: prompt.length,
      promptSample: prompt.substring(0, 300)
    }, '🔧 PARSERS: Calling LLM for intent detection');

    const raw = await callLLM(prompt, { responseFormat: 'json', log: logger });
    
    logger?.debug?.({ 
      rawResponse: raw.substring(0, 500),
      rawLength: raw.length
    }, '🔧 PARSERS: LLM response received for intent detection');
    
    const parsed = IntentDetectionSchema.parse(JSON.parse(raw));
    
    logger?.debug?.({ 
      intent: parsed.intent,
      confidence: parsed.confidence,
      needExternal: parsed.needExternal,
      slotsCount: Object.keys(parsed.slots || {}).length,
      slots: parsed.slots
    }, '🔧 PARSERS: Intent detection completed successfully');
    
    return parsed;
  } catch (error) {
    logger?.error?.({ 
      error: String(error),
      text: text.substring(0, 100)
    }, '🔧 PARSERS: Intent detection failed');
    return null;
  }
}

export async function parseCity(
  text: string,
  context?: Record<string, any>,
  logger?: pino.Logger,
): Promise<ParseResponse<CityParseResultT>> {
  try {
    const template = await getPrompt('city_parser');
    const prompt = template
      .replace('{text}', escapeForPrompt(text))
      .replace('{context}', stringifyContext(context));
    const raw = await callLLM(prompt, { responseFormat: 'json', log: logger });
    const result = CityParseResult.parse(JSON.parse(raw));

    if (result.city && result.normalized && result.confidence >= CITY_CONF_THRESHOLD) {
      return { success: true, data: result, confidence: result.confidence, normalized: result.normalized };
    }

    return { success: false, data: result, confidence: result.confidence, normalized: result.normalized };
  } catch (error) {
    logger?.debug?.({ error: String(error) }, 'parse_city_failed');
    return { success: false, data: null, confidence: 0 };
  }
}

export async function parseDate(
  text: string,
  context?: Record<string, any>,
  logger?: pino.Logger,
): Promise<ParseResponse<DateParseResultT>> {
  try {
    const template = await getPrompt('date_parser');
    const prompt = template
      .replace('{text}', escapeForPrompt(text))
      .replace('{context}', stringifyContext(context));
    const raw = await callLLM(prompt, { responseFormat: 'json', log: logger });
    const result = DateParseResult.parse(JSON.parse(raw));

    if (result.dates && result.confidence >= DATE_CONF_THRESHOLD) {
      return { success: true, data: result, confidence: result.confidence, normalized: result.dates };
    }
    return { success: false, data: result, confidence: result.confidence, normalized: result.dates };
  } catch (error) {
    logger?.debug?.({ error: String(error) }, 'parse_date_failed');
    return { success: false, data: null, confidence: 0 };
  }
}

export async function parseOriginDestination(
  text: string,
  context?: Record<string, any>,
  logger?: pino.Logger,
): Promise<ParseResponse<OriginDestinationParseResultT>> {
  try {
    const template = await getPrompt('origin_destination_extractor');
    const prompt = template
      .replace('{text}', escapeForPrompt(text))
      .replace('{context}', stringifyContext(context));
    const raw = await callLLM(prompt, { responseFormat: 'json', log: logger });
    const result = OriginDestinationParseResult.parse(JSON.parse(raw));

    if (result.confidence >= OD_CONF_THRESHOLD && (result.originCity || result.destinationCity)) {
      return { success: true, data: result, confidence: result.confidence };
    }
    return { success: false, data: result, confidence: result.confidence };
  } catch (error) {
    logger?.debug?.({ error: String(error) }, 'parse_od_failed');
    return { success: false, data: null, confidence: 0 };
  }
}

export async function parseIntent(
  text: string,
  context?: Record<string, any>,
  logger?: pino.Logger,
): Promise<ParseResponse<z.infer<typeof IntentParseResult>>> {
  const detection = await detectIntentAndSlots(text, context, logger);
  if (!detection) {
    return { success: false, data: null, confidence: 0 };
  }

  const slots: Record<string, string> = {};
  for (const [key, value] of Object.entries(detection.slots || {})) {
    const normalized = normalizeSlotValue(value);
    if (normalized) slots[key] = normalized;
  }

  const reducedIntent = detection.intent === 'flights' ? 'unknown' : detection.intent;

  const parsed = IntentParseResult.parse({
    intent: reducedIntent,
    confidence: detection.confidence,
    slots,
  });

  return { success: true, data: parsed, confidence: detection.confidence };
}

export async function extractSlots(
  text: string,
  context?: Record<string, any>,
  logger?: pino.Logger,
): Promise<Record<string, string>> {
  logger?.debug?.({ 
    text: text.substring(0, 200),
    contextKeys: Object.keys(context || {}),
    contextValues: context
  }, '🔧 PARSERS: Starting slot extraction');
  
  const slots: Record<string, string> = {};
  const detection = await detectIntentAndSlots(text, context, logger);

  if (detection) {
    logger?.debug?.({ 
      detectionSlots: detection.slots,
      detectionSlotsCount: Object.keys(detection.slots || {}).length
    }, '🔧 PARSERS: Processing detection slots');
    
    mergeSlots(slots, Object.entries(detection.slots || {}).reduce<Record<string, string>>((acc, [key, value]) => {
      const normalized = normalizeSlotValue(value);
      if (normalized) {
        acc[key] = normalized;
        logger?.debug?.({ key, originalValue: value, normalizedValue: normalized }, '🔧 PARSERS: Normalized slot value');
      }
      return acc;
    }, {}));
  } else {
    logger?.debug?.('🔧 PARSERS: No detection result, proceeding with individual parsers');
  }

  if (!slots.city) {
    logger?.debug?.('🔧 PARSERS: No city in slots, attempting city parsing');
    const city = await parseCity(text, context, logger);
    if (city.success && city.data?.normalized) {
      slots.city = city.data.normalized;
      logger?.debug?.({ city: city.data.normalized, confidence: city.confidence }, '🔧 PARSERS: City extracted successfully');
      if (city.data.country && !slots.country) {
        slots.country = city.data.country;
        logger?.debug?.({ country: city.data.country }, '🔧 PARSERS: Country extracted from city parsing');
      }
    } else {
      logger?.debug?.({ 
        success: city.success, 
        confidence: city.confidence,
        cityData: city.data
      }, '🔧 PARSERS: City parsing failed or low confidence');
    }
  }

  if (!slots.originCity || !slots.destinationCity) {
    logger?.debug?.({ 
      hasOrigin: !!slots.originCity, 
      hasDestination: !!slots.destinationCity 
    }, '🔧 PARSERS: Missing origin/destination, attempting OD parsing');
    
    const od = await parseOriginDestination(text, context, logger);
    if (od.success && od.data) {
      if (od.data.originCity && !slots.originCity) {
        slots.originCity = od.data.originCity;
        logger?.debug?.({ originCity: od.data.originCity }, '🔧 PARSERS: Origin city extracted');
      }
      if (od.data.destinationCity && !slots.destinationCity) {
        slots.destinationCity = od.data.destinationCity;
        logger?.debug?.({ destinationCity: od.data.destinationCity }, '🔧 PARSERS: Destination city extracted');
      }
    } else {
      logger?.debug?.({ 
        success: od.success, 
        confidence: od.confidence,
        odData: od.data
      }, '🔧 PARSERS: Origin/destination parsing failed or low confidence');
    }
  }

  if (!slots.dates && !slots.month) {
    logger?.debug?.({ 
      hasDates: !!slots.dates, 
      hasMonth: !!slots.month 
    }, '🔧 PARSERS: Missing dates/month, attempting date parsing');
    
    const date = await parseDate(text, context, logger);
    if (date.success && date.data) {
      if (date.data.dates) {
        slots.dates = date.data.dates;
        logger?.debug?.({ dates: date.data.dates }, '🔧 PARSERS: Dates extracted');
      }
      if (date.data.month) {
        slots.month = date.data.month;
        logger?.debug?.({ month: date.data.month }, '🔧 PARSERS: Month extracted');
      }
    } else {
      logger?.debug?.({ 
        success: date.success, 
        confidence: date.confidence,
        dateData: date.data
      }, '🔧 PARSERS: Date parsing failed or low confidence');
    }
  }

  if (slots.passengers && !/^[0-9]+$/.test(slots.passengers)) {
    logger?.debug?.({ originalPassengers: slots.passengers }, '🔧 PARSERS: Normalizing passengers count');
    const parsedPassengers = parseInt(slots.passengers, 10);
    if (Number.isFinite(parsedPassengers) && parsedPassengers > 0) {
      slots.passengers = String(parsedPassengers);
      logger?.debug?.({ normalizedPassengers: slots.passengers }, '🔧 PARSERS: Passengers normalized');
    } else {
      delete slots.passengers;
      logger?.debug?.('🔧 PARSERS: Invalid passengers count, removed from slots');
    }
  }

  logger?.debug?.({ 
    finalSlots: slots,
    slotsCount: Object.keys(slots).length
  }, '🔧 PARSERS: Slot extraction completed');

  return slots;
}

export async function extractFlightSlotsOnce(
  text: string,
  context?: Record<string, any>,
  logger?: pino.Logger,
): Promise<Record<string, string>> {
  try {
    const template = await getPrompt('flight_slot_extractor');
    const prompt = template
      .replace('{text}', escapeForPrompt(text))
      .replace('{context}', stringifyContext(context));
    const raw = await callLLM(prompt, { responseFormat: 'json', log: logger });
    const json = JSON.parse(raw) as Record<string, unknown>;
    const slots: Record<string, string> = {};

    for (const key of ['originCity', 'destinationCity', 'city', 'departureDate', 'returnDate', 'dates', 'month', 'cabinClass']) {
      const normalized = normalizeSlotValue(json[key]);
      if (normalized) slots[key] = normalized;
    }

    if (Number.isFinite(json.passengers)) {
      const passengers = Number(json.passengers);
      if (passengers > 0) slots.passengers = String(passengers);
    }

    return Object.keys(slots).length > 0 ? slots : await extractSlots(text, context, logger);
  } catch (error) {
    logger?.debug?.({ error: String(error) }, 'flight_slot_extractor_failed');
    return extractSlots(text, context, logger);
  }
}
