import type { Logger } from 'pino';
import { getPrompt } from './prompts.js';
import { callLLM } from './llm.js';

type ConsentVerdict = 'yes' | 'no' | 'unclear';

const cache = new Map<string, ConsentVerdict>();

export async function classifyConsentResponse(message: string, log?: Logger): Promise<ConsentVerdict> {
  const trimmed = message.trim();
  if (!trimmed) return 'unclear';

  const lower = trimmed.toLowerCase();
  if (YES_WORDS.some((w) => lower === w || lower.startsWith(`${w} `))) {
    return 'yes';
  }
  if (NO_WORDS.some((w) => lower === w || lower.startsWith(`${w} `))) {
    return 'no';
  }

  const cached = cache.get(trimmed);
  if (cached) return cached;

  const promptTemplate = await getPrompt('consent_detector');
  const prompt = promptTemplate.replace('{message}', trimmed);

  try {
    const response = await callLLM(prompt, { responseFormat: 'text', log });
    const verdict = normalize(response);
    cache.set(trimmed, verdict);
    return verdict;
  } catch (error) {
    log?.debug({ error: String(error) }, 'consent_classifier_failed');
    return 'unclear';
  }
}

function normalize(raw: string): ConsentVerdict {
  const cleaned = raw.trim().toLowerCase();
  if (cleaned.startsWith('yes')) return 'yes';
  if (cleaned.startsWith('no')) return 'no';
  if (cleaned === 'unclear') return 'unclear';
  return 'unclear';
}

const YES_WORDS = ['yes', 'y', 'sure', 'ok', 'okay', 'go ahead', 'proceed', 'continue', 'search'];
const NO_WORDS = ['no', 'n', 'nope', 'skip', 'pass', 'cancel'];
