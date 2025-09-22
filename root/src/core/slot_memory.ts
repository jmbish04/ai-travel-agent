import type { Fact, Decision } from './receipts.js';
import { getSessionStore } from './session_store.js';

const isDebugMode = process.env.LOG_LEVEL === 'debug';

function debugLog(message: string, data?: any) {
  if (isDebugMode) {
    console.debug(message, data);
  }
}

// Semantic temporal reference detection
export function isTemporalReference(value: string): boolean {
  const temporal = new Set(['today', 'now', 'currently', 'right now', 'this moment', 'present']);
  return temporal.has(value.toLowerCase().trim());
}

type SlotState = {
  slots: Record<string, string>;
  expectedMissing: string[];
  lastIntent?: 'weather'|'destinations'|'packing'|'attractions'|'policy'|'flights'|'unknown'|'web_search'|'system';
  lastFacts?: Fact[];
  lastDecisions?: Array<string | Decision>;
  lastReply?: string;
  lastUserMessage?: string;
  prevUserMessage?: string;
  lastVerification?: {
    verdict: 'pass'|'warn'|'fail';
    notes: string[];
    scores?: { relevance: number; grounding: number; coherence: number; context_consistency: number };
    revisedAnswer?: string;
    reply?: string;
    createdAt?: number;
  };
};

export async function getThreadSlots(threadId: string): Promise<Record<string, string>> {
  const store = getSessionStore();
  const slots = await store.getSlots(threadId);
  debugLog('🔧 SLOTS: getThreadSlots', { threadId, slots });
  return slots;
}

export async function getExpectedMissing(threadId: string): Promise<string[]> {
  const store = getSessionStore();
  const state = await store.getJson<SlotState>('state', threadId);
  return state?.expectedMissing ?? [];
}

export async function updateThreadSlots(
  threadId: string,
  slots: Record<string, string | null>,
  expectedMissing: string[] = [],
  remove: string[] = [],
): Promise<void> {
  // Filter out null values
  const filteredSlots: Record<string, string> = {};
  for (const [k, v] of Object.entries(slots)) {
    if (typeof v === 'string' && v.trim().length > 0) {
      filteredSlots[k] = v;
    }
  }

  const store = getSessionStore();
  const prevState = await store.getJson<SlotState>('state', threadId) ?? { slots: {}, expectedMissing: [] };
  
  debugLog('🔧 SLOTS: updateThreadSlots', { 
    threadId, 
    newSlots: filteredSlots, 
    prevSlots: prevState.slots, 
  });
  
  // Update slots
  await store.setSlots(threadId, filteredSlots, remove.length ? Array.from(new Set(remove)) : undefined);
  
  // Update state
  const newState = { ...prevState, expectedMissing };
  await store.setJson('state', threadId, newState);
}

export async function clearThreadSlots(threadId: string): Promise<void> {
  const store = getSessionStore();
  await store.clear(threadId);
}

export async function setLastIntent(threadId: string, intent: 'weather'|'destinations'|'packing'|'attractions'|'policy'|'flights'|'unknown'|'web_search'|'system'): Promise<void> {
  const store = getSessionStore();
  const prev = await store.getJson<SlotState>('state', threadId) ?? { slots: {}, expectedMissing: [] };
  await store.setJson('state', threadId, { ...prev, lastIntent: intent });
}

export async function getLastIntent(threadId: string): Promise<'weather'|'destinations'|'packing'|'attractions'|'policy'|'flights'|'irrops'|'unknown'|'web_search'|'system'|undefined> {
  const store = getSessionStore();
  const state = await store.getJson<SlotState>('state', threadId);
  return state?.lastIntent;
}

export async function setLastReceipts(
  threadId: string,
  facts: Fact[],
  decisions: Array<string | Decision>,
  reply?: string,
): Promise<void> {
  const store = getSessionStore();
  const prev = await store.getJson<SlotState>('state', threadId) ?? { slots: {}, expectedMissing: [] };
  await store.setJson('state', threadId, { ...prev, lastFacts: facts, lastDecisions: decisions, lastReply: reply });
}

export async function getLastReceipts(threadId: string): Promise<{ facts?: Fact[]; decisions?: Array<string | Decision>; reply?: string }> {
  const store = getSessionStore();
  const state = await store.getJson<SlotState>('state', threadId);
  return { facts: state?.lastFacts, decisions: state?.lastDecisions, reply: state?.lastReply };
}

export async function getLastUserMessage(threadId: string): Promise<string | undefined> {
  const store = getSessionStore();
  const state = await store.getJson<SlotState>('state', threadId);
  return state?.lastUserMessage;
}

export async function setLastUserMessage(threadId: string, message: string): Promise<void> {
  const store = getSessionStore();
  const prev = await store.getJson<SlotState>('state', threadId) ?? { slots: {}, expectedMissing: [] };
  const withPrev = { ...prev, prevUserMessage: prev.lastUserMessage, lastUserMessage: message };
  await store.setJson('state', threadId, withPrev);
}

export async function getPrevUserMessage(threadId: string): Promise<string | undefined> {
  const store = getSessionStore();
  const state = await store.getJson<SlotState>('state', threadId);
  return state?.prevUserMessage;
}

export async function setLastVerification(threadId: string, artifact: Required<Pick<SlotState,'lastVerification'>>['lastVerification']): Promise<void> {
  const store = getSessionStore();
  const prev = await store.getJson<SlotState>('state', threadId) ?? { slots: {}, expectedMissing: [] };
  await store.setJson('state', threadId, { ...prev, lastVerification: { ...artifact, createdAt: Date.now() } });
}

export async function getLastVerification(threadId: string): Promise<SlotState['lastVerification'] | undefined> {
  const store = getSessionStore();
  const state = await store.getJson<SlotState>('state', threadId);
  return state?.lastVerification;
}

const LOCATION_KEY_ORDER = ['city', 'destinationCity', 'country', 'originCity', 'region', 'state', 'countryName'];
const TIME_KEYS = ['month', 'dates', 'departureDate', 'returnDate', 'travelWindow', 'travelDates'];
const PROFILE_KEYS = ['travelerProfile', 'travelStyle', 'groupType', 'budgetLevel', 'activityType', 'tripPurpose'];

function normalizeLocationName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

const PLACEHOLDER_LOCATION_TOKENS = new Set([
  'there',
  'here',
  'sameplace',
  'samedestination',
  'samecity',
  'thesameplace',
  'thesamedestination',
  'thesamecity',
  'samearea',
  'thesamearea',
  'samehotel',
  'thesamehotel',
  'thatplace',
  'thatcity',
  'thatdestination',
]);

export function isPlaceholderLocation(value?: string): boolean {
  if (!value) return false;
  const normalized = normalizeLocationName(value);
  return normalized.length > 0 && PLACEHOLDER_LOCATION_TOKENS.has(normalized);
}

export function resolveLocationPlaceholder(value?: string, fallback?: string): string | undefined {
  if (!value) return fallback?.trim();
  const trimmed = value.trim();
  if (!trimmed) return fallback?.trim();
  if (isPlaceholderLocation(trimmed)) {
    return fallback?.trim();
  }
  return trimmed;
}

function getPrimaryLocation(slots: Record<string, string>): string | undefined {
  for (const key of LOCATION_KEY_ORDER) {
    const value = slots[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function normalizeSlots(
  prior: Record<string, string>, 
  extracted: Record<string, string | null>,
  intent?: string
): Record<string, string> {
  let out = { ...prior };
  const safe: Record<string, string> = {};

  // Convert null values to empty strings and filter out
  for (const [key, value] of Object.entries(extracted)) {
    if (value !== null && typeof value === 'string' && value.trim()) {
      safe[key] = value;
    }
  }

  // 1) Clean temporal references from city fields using semantic detection
  for (const k of ['city', 'destinationCity', 'originCity']) {
    if (typeof safe[k] === 'string') {
      const cleaned = safe[k].replace(/\b(today|now)\b/gi, '').trim();
      // Use semantic validation instead of regex
      if (!cleaned || isTemporalReference(cleaned)) {
        delete safe[k];
      } else {
        safe[k] = cleaned;
      }
    }
  }

  const priorDestination = prior.destinationCity?.trim() || prior.city?.trim();
  const priorOrigin = prior.originCity?.trim() || prior.city?.trim();
  const priorCity = prior.city?.trim() || priorDestination || priorOrigin;

  for (const key of ['destinationCity', 'city', 'originCity'] as const) {
    const value = safe[key];
    if (typeof value === 'string') {
      const fallback = key === 'destinationCity'
        ? priorDestination || priorCity
        : key === 'originCity'
          ? priorOrigin || priorDestination || priorCity
          : priorCity || priorDestination || priorOrigin;
      const resolved = resolveLocationPlaceholder(value, fallback);
      if (resolved) {
        safe[key] = resolved;
      } else {
        delete safe[key];
      }
    }
  }

  // 2) Don't backfill month/dates from "today" for non-flight intents.
  // For flights we must preserve relative dates like "today"/"tomorrow".
  if (intent !== 'flights') {
    if (safe.month && isTemporalReference(safe.month)) delete safe.month;
    if (safe.dates && isTemporalReference(safe.dates)) delete safe.dates;
  }

  // 2b) For flights, map relative dates into departureDate if missing
  if (intent === 'flights') {
    const relativeDates = new Set(['today', 'tomorrow', 'tonight']);
    if (safe.dates && !safe.departureDate && relativeDates.has(safe.dates.toLowerCase())) {
      safe.departureDate = safe.dates;
    }
  }

  // 3) Intent-scoped writes to prevent cross-contamination
  if (intent === 'weather') {
    // Weather queries should not write flight-related slots
    delete safe.originCity;
    delete safe.destinationCity;
    delete safe.dates; // Don't persist dates from "today"
    delete safe.month;
  }

  // 4) Apply existing filtering logic
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(safe)) {
    if (typeof value === 'string' && value.trim()) {
      const v = value.toLowerCase();
      const placeholderTokens = ['unknown', 'clean_city_name', 'there', 'normalized_name'];
      const datePlaceholders = ['unknown', 'next week', 'normalized_date_string', 'month_name'];
      
      if (key === 'city') {
        if (placeholderTokens.includes(v)) continue;
        // Use semantic validation instead of regex
        const genericWords = new Set(['city', 'destination', 'place', 'location', 'area']);
        const containsGeneric = Array.from(genericWords).some(w => v.toLowerCase().includes(w));
        const hasValidLength = value.length >= 2 && value.length <= 50;
        const isNotEmpty = value.trim().length > 0;
        if (!hasValidLength || !isNotEmpty || containsGeneric) continue;
        filtered[key] = value;
        continue;
      }
      
      if (!datePlaceholders.includes(v)) {
        filtered[key] = value;
      }
    }
  }

  const priorPrimary = getPrimaryLocation(prior);
  const newPrimary = getPrimaryLocation(filtered);

  if (newPrimary) {
    if (!priorPrimary || normalizeLocationName(priorPrimary) !== normalizeLocationName(newPrimary)) {
      out = {};
    }
  }

  const merged = { ...out, ...filtered };

  if (newPrimary && (!priorPrimary || normalizeLocationName(priorPrimary) !== normalizeLocationName(newPrimary))) {
    for (const key of [...TIME_KEYS, ...PROFILE_KEYS]) {
      if (!(key in filtered) && key in merged) delete merged[key];
    }
  }

  return merged;
}

export function readConsentState(slots: Record<string, string>) {
  return {
    awaiting: !!(slots.awaiting_search_consent === 'true' || slots.awaiting_deep_research_consent === 'true' || slots.awaiting_web_search_consent === 'true'),
    type: slots.awaiting_deep_research_consent === 'true' ? 'deep' :
          slots.awaiting_search_consent === 'true' ? 'web' : 
          slots.awaiting_web_search_consent === 'true' ? 'web_after_rag' : '',
    pending: slots.pending_deep_research_query || slots.pending_search_query || slots.pending_web_search_query || ''
  };
}

export async function writeConsentState(threadId: string, next: { type: 'web' | 'deep' | 'web_after_rag' | '', pending: string }): Promise<void> {
  const updates: Record<string, string> = {
    awaiting_search_consent: '',
    pending_search_query: '',
    awaiting_deep_research_consent: '',
    pending_deep_research_query: '',
    awaiting_web_search_consent: '',
    pending_web_search_query: ''
  };
  
  if (next.type === 'web') {
    updates.awaiting_search_consent = 'true';
    updates.pending_search_query = next.pending;
  } else if (next.type === 'deep') {
    updates.awaiting_deep_research_consent = 'true';
    updates.pending_deep_research_query = next.pending;
  } else if (next.type === 'web_after_rag') {
    updates.awaiting_web_search_consent = 'true';
    updates.pending_web_search_query = next.pending;
  }
  
  await updateThreadSlots(threadId, updates, []);
}
