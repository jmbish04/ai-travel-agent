import type { Logger } from 'pino';
import { getPrompt } from './prompts.js';
import { callLLM } from './llm.js';

export type SearchUpgradeResult = {
  upgrade: boolean;
  confidence: number;
  reason: string;
  usedLLM: boolean;
};

type CachedVerdict = Omit<SearchUpgradeResult, 'usedLLM'>;

const cache = new Map<string, CachedVerdict>();

function buildCacheKey(message: string, previousQuery: string, previousAnswer?: string): string {
  return [message.trim(), previousQuery.trim(), (previousAnswer ?? '').trim()].join('|||');
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number.parseFloat(value.toFixed(2));
}

/**
 * Detects whether the user is asking to deepen the previous web search.
 */
export async function detectSearchUpgradeRequest({
  message,
  previousQuery,
  previousAnswer,
  log,
}: {
  message: string;
  previousQuery?: string;
  previousAnswer?: string;
  log?: Logger;
}): Promise<SearchUpgradeResult> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage || !previousQuery?.trim()) {
    return {
      upgrade: false,
      confidence: 0,
      reason: 'Missing message or previous query context',
      usedLLM: false,
    };
  }

  const key = buildCacheKey(trimmedMessage, previousQuery, previousAnswer);
  const cached = cache.get(key);
  if (cached) {
    return { ...cached, usedLLM: false };
  }

  try {
    const promptTemplate = await getPrompt('search_upgrade_detector');
    const prompt = promptTemplate
      .replace('{user_message}', trimmedMessage)
      .replace('{previous_query}', previousQuery.trim())
      .replace('{previous_answer}', (previousAnswer ?? '').trim() || '');

    const raw = await callLLM(prompt, { responseFormat: 'json', log });
    const parsed = JSON.parse(raw) as {
      upgrade?: boolean;
      confidence?: number | string;
      reason?: string;
    };

    const upgrade = parsed.upgrade === true;
    const confidenceInput =
      typeof parsed.confidence === 'number'
        ? parsed.confidence
        : typeof parsed.confidence === 'string'
          ? Number.parseFloat(parsed.confidence)
          : 0;
    const confidence = clampConfidence(confidenceInput);
    const reason = (parsed.reason ?? '').toString().trim().slice(0, 120);

    const verdict: CachedVerdict = { upgrade, confidence, reason };
    cache.set(key, verdict);
    return { ...verdict, usedLLM: true };
  } catch (error) {
    log?.debug?.({ error: error instanceof Error ? error.message : String(error) }, 'search_upgrade_detect_failed');
    return {
      upgrade: false,
      confidence: 0,
      reason: 'Detector failure',
      usedLLM: false,
    };
  }
}
