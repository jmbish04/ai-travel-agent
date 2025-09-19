import type { Fact, Decision } from './receipts.js';
import { getSessionStore } from './session_store.js';

const isDebugMode = process.env.LOG_LEVEL === 'debug';

function debugLog(message: string, data?: any) {
  if (isDebugMode) {
    console.debug(message, data);
  }
}

type SlotState = {
  slots: Record<string, string>;
  expectedMissing: string[];
  lastIntent?: 'weather'|'destinations'|'packing'|'attractions'|'policy'|'flights'|'unknown'|'web_search'|'system';
  lastFacts?: Fact[];
  lastDecisions?: Array<string | Decision>;
  lastReply?: string;
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
  await store.setSlots(threadId, filteredSlots);
  
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

export async function getLastIntent(threadId: string): Promise<'weather'|'destinations'|'packing'|'attractions'|'policy'|'flights'|'unknown'|'web_search'|'system'|undefined> {
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

export function normalizeSlots(
  prior: Record<string, string>, 
  extracted: Record<string, string | null>,
  intent?: string
): Record<string, string> {
  const out = { ...prior };
  const safe: Record<string, string> = {};

  // Convert null values to empty strings and filter out
  for (const [key, value] of Object.entries(extracted)) {
    if (value !== null && typeof value === 'string' && value.trim()) {
      safe[key] = value;
    }
  }

  // 1) Strip "today/now" from city/destination fields
  for (const k of ['city', 'destinationCity', 'originCity']) {
    if (typeof safe[k] === 'string') {
      safe[k] = safe[k].replace(/\b(today|now)\b/gi, '').trim();
      // Reject if contains digits or is empty after cleanup
      if (/\d/.test(safe[k]) || !safe[k]) delete safe[k];
    }
  }

  // 2) Don't backfill month/dates from "today" for non-flight intents.
  // For flights we must preserve relative dates like "today"/"tomorrow".
  if (intent !== 'flights') {
    if (safe.month && /today|now/i.test(safe.month)) delete safe.month;
    if (safe.dates && /today|now/i.test(safe.dates)) delete safe.dates;
  }

  // 2b) For flights, map relative dates into departureDate if missing
  if (intent === 'flights') {
    if (safe.dates && !safe.departureDate && /^(today|tomorrow|tonight)$/i.test(safe.dates)) {
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
        const looksProper = /^[A-Z][A-Za-z\- ]+$/.test(value);
        const genericWords = ['city', 'destination', 'place'];
        const containsGeneric = genericWords.some(w => v.includes(w));
        if (!looksProper || containsGeneric) continue;
        filtered[key] = value;
        continue;
      }
      
      if (!datePlaceholders.includes(v)) {
        filtered[key] = value;
      }
    }
  }

  return { ...out, ...filtered };
}

export function readConsentState(slots: Record<string, string>) {
  return {
    awaiting: !!(slots.awaiting_search_consent === 'true' || slots.awaiting_deep_research_consent === 'true' || slots.awaiting_web_search_consent === 'true'),
    type: slots.awaiting_search_consent === 'true' ? 'web' : 
          slots.awaiting_deep_research_consent === 'true' ? 'deep' : 
          slots.awaiting_web_search_consent === 'true' ? 'web_after_rag' : '',
    pending: slots.pending_search_query || slots.pending_deep_research_query || slots.pending_web_search_query || ''
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

