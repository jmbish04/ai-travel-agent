/**
 * Graph optimization helpers used by the conversation graph.
 * Heavy regex heuristics were removed in favour of LLM-first flows.
 */

import type pino from 'pino';

export type TurnCache = {
  msgRaw: string;
  msgL: string;
  words: Set<string>;
  clsContent?: { content_type: string; confidence: number };
  route?: { intent: string; slots: Record<string, string>; confidence: number };
  forced?: string;
};

export async function buildTurnCache(message: string, _log: pino.Logger): Promise<TurnCache> {
  const normalized = message.trim().toLowerCase();
  const words = new Set(normalized.split(/\s+/).filter(Boolean));
  return { msgRaw: message, msgL: normalized, words };
}

const YES_WORDS = new Set(['yes', 'y', 'sure', 'ok', 'okay', 'go ahead', 'proceed', 'continue', 'search']);
const NO_WORDS = new Set(['no', 'n', 'nope', 'skip', 'pass', 'cancel']);

export function checkYesNoShortcut(message: string): 'yes' | 'no' | null {
  const lower = message.trim().toLowerCase();
  if (!lower) return null;
  if (YES_WORDS.has(lower)) return 'yes';
  if (NO_WORDS.has(lower)) return 'no';
  return null;
}

export type NodeOut =
  | { next: 'weather' | 'destinations' | 'packing' | 'attractions' | 'policy' | 'flights' | 'unknown' | 'web_search' | 'system'; slots?: Record<string, string> }
  | { done: true; reply: string; citations?: string[] };

export type RuleContext = {
  C: TurnCache;
  slots: Record<string, string>;
  forced?: string;
  threadId: string;
  log: pino.Logger;
};

export async function maybeFastWeather(_ctx: RuleContext): Promise<NodeOut | null> {
  return null; // Weather fast-path now handled via router and prompts.
}

export async function routeToDomain(ctx: RuleContext): Promise<NodeOut | null> {
  const intent = ctx.forced || ctx.C.route?.intent || 'unknown';
  return { next: intent as any, slots: ctx.C.route?.slots ?? {} };
}

export function incrementCounter(_name: string, _labels?: Record<string, string>) {
  // placeholder for metrics integration
}
