import { callLLM, safeExtractJson } from './llm.js';
import { getPrompt } from './prompts.js';
import { z } from 'zod';

/**
 * Authenticity score for a policy/source domain.
 */
export interface DomainScore {
  domain: string;
  confidence: number;
  reasoning: 'llm_classified';
  isOfficial: boolean;
}

// Cache to avoid duplicate LLM calls
const domainCache = new Map<string, number>();

const LlmOut = z.object({
  is_official: z.boolean(),
  score: z.number().min(0).max(1),
  subject_type: z.enum(['brand','country','other']).optional().default('other'),
});

async function classifyWithLLM(
  domain: string,
  airlineName: string,
  clause?: string,
  signal?: AbortSignal,
): Promise<number> {
  // Bump cache version when prompt guidance changes to avoid stale scores
  const cacheKey = `v3:${domain}:${airlineName}:${clause ?? ''}`;
  if (domainCache.has(cacheKey)) {
    const cached = domainCache.get(cacheKey)!;
    console.log(`🏆 Using cached score for ${domain}: ${cached}`);
    return cached;
  }

  try {
    const prompt = await getPrompt('domain_authenticity_classifier');
    const filled = prompt
      .replace('{{domain}}', domain)
      .replace('{{airlineName}}', airlineName)
      .replace('{{clause}}', (clause ?? 'other'));
    
    const response = await callLLM(filled, { responseFormat: 'json', log: undefined, timeoutMs: 2000, signal });
    const parsedUnknown = (() => {
      try { return JSON.parse(response); } catch { return safeExtractJson(response); }
    })();
    const parsed = LlmOut.safeParse(parsedUnknown);
    if (!parsed.success) {
      console.log(`❌ LLM JSON validation failed for ${domain}:`, parsed.error.issues.map(i => i.message).join('; '));
      domainCache.set(cacheKey, 0.5);
      return 0.5;
    }
    const score = Math.max(0.05, Math.min(0.95, parsed.data.score));
    console.log(`🏆 Parsed JSON score for ${domain}: ${score} (official=${parsed.data.is_official})`);
    domainCache.set(cacheKey, score);
    return score;
  } catch (error) {
    console.log(`❌ LLM classification failed for ${domain}:`, error);
    domainCache.set(cacheKey, 0.5);
    return 0.5;
  }
}

/**
 * Classify if a domain is an official source for the given subject.
 * LLM-first with strict JSON; no heuristic allow/deny lists.
 */
export async function scoreDomainAuthenticity(
  domain: string,
  airlineName: string,
  signal?: AbortSignal,
  clause?: string,
): Promise<DomainScore> {
  // AI-first with strict JSON, with a minimal regex fallback inside classifyWithLLM
  const confidence = await classifyWithLLM(domain, airlineName, clause, signal);
  return {
    domain,
    confidence,
    reasoning: 'llm_classified',
    isOfficial: confidence >= 0.6
  };
}
