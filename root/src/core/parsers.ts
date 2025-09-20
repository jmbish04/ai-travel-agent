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

async function detectIntentAndSlots(
  text: string,
  context?: Record<string, any>,
  logger?: pino.Logger,
): Promise<IntentDetection | null> {
  try {
    const template = await getPrompt('nlp_intent_detection');
    const prompt = template
      .replace('{message}', escapeForPrompt(text))
      .replace('{context}', stringifyContext(context));

    const raw = await callLLM(prompt, { responseFormat: 'json', log: logger });
    const parsed = IntentDetectionSchema.parse(JSON.parse(raw));
    return parsed;
  } catch (error) {
    logger?.debug?.({ error: String(error) }, 'intent_detection_failed');
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
  const slots: Record<string, string> = {};
  const detection = await detectIntentAndSlots(text, context, logger);

  if (detection) {
    mergeSlots(slots, Object.entries(detection.slots || {}).reduce<Record<string, string>>((acc, [key, value]) => {
      const normalized = normalizeSlotValue(value);
      if (normalized) acc[key] = normalized;
      return acc;
    }, {}));
  }

  if (!slots.city) {
    const city = await parseCity(text, context, logger);
    if (city.success && city.data?.normalized) {
      slots.city = city.data.normalized;
      if (city.data.country && !slots.country) {
        slots.country = city.data.country;
      }
    }
  }

  if (!slots.originCity || !slots.destinationCity) {
    const od = await parseOriginDestination(text, context, logger);
    if (od.success && od.data) {
      if (od.data.originCity && !slots.originCity) slots.originCity = od.data.originCity;
      if (od.data.destinationCity && !slots.destinationCity) slots.destinationCity = od.data.destinationCity;
    }
  }

  if (!slots.dates && !slots.month) {
    const date = await parseDate(text, context, logger);
    if (date.success && date.data) {
      if (date.data.dates) slots.dates = date.data.dates;
      if (date.data.month) slots.month = date.data.month;
    }
  }

  if (slots.passengers && !/^[0-9]+$/.test(slots.passengers)) {
    const parsedPassengers = parseInt(slots.passengers, 10);
    if (Number.isFinite(parsedPassengers) && parsedPassengers > 0) {
      slots.passengers = String(parsedPassengers);
    } else {
      delete slots.passengers;
    }
  }

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
