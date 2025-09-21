import { callLLM } from './llm.js';
import { getPrompt } from './prompts.js';

export interface DomainScore {
  domain: string;
  confidence: number;
  reasoning: 'llm_classified';
  isOfficial: boolean;
}

// Cache to avoid duplicate LLM calls
const domainCache = new Map<string, number>();

async function classifyWithLLM(domain: string, airlineName: string, signal?: AbortSignal): Promise<number> {
  const cacheKey = `${domain}:${airlineName}`;
  if (domainCache.has(cacheKey)) {
    const cached = domainCache.get(cacheKey)!;
    console.log(`🏆 Using cached score for ${domain}: ${cached}`);
    return cached;
  }

  try {
    const prompt = await getPrompt('domain_authenticity_classifier');
    const filled = prompt
      .replace('{{domain}}', domain)
      .replace('{{airlineName}}', airlineName);
    
    const response = await callLLM(filled, { responseFormat: 'text' });
    console.log(`🏆 Domain LLM response for ${domain}: "${response.trim()}"`);
    
    // Look for the last number in response (most likely the score)
    const numbers = response.match(/(\d+(?:\.\d+)?)/g);
    if (!numbers) {
      console.log(`❌ No number found in LLM response: "${response}"`);
      domainCache.set(cacheKey, 0.5);
      return 0.5;
    }
    
    // Take the last number found (usually the final score)
    const lastNumber = numbers[numbers.length - 1];
    if (!lastNumber) {
      console.log(`❌ No valid number found in response: "${response}"`);
      domainCache.set(cacheKey, 0.5);
      return 0.5;
    }
    
    let score = parseFloat(lastNumber);
    if (score > 1) score /= 100;
    const finalScore = Math.max(0.05, Math.min(0.95, score));
    
    console.log(`🏆 Parsed score for ${domain}: ${finalScore}`);
    domainCache.set(cacheKey, finalScore);
    return finalScore;
  } catch (error) {
    console.log(`❌ LLM classification failed for ${domain}:`, error);
    domainCache.set(cacheKey, 0.5);
    return 0.5;
  }
}

export async function scoreDomainAuthenticity(
  domain: string, 
  airlineName: string,
  signal?: AbortSignal
): Promise<DomainScore> {
  const confidence = await classifyWithLLM(domain, airlineName);
  
  return {
    domain,
    confidence,
    reasoning: 'llm_classified',
    isOfficial: confidence >= 0.6
  };
}
