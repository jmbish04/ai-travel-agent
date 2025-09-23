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
  // Bump cache version when prompt guidance changes to avoid stale scores
  const cacheKey = `v2:${domain}:${airlineName}`;
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

function hostFrom(input: string): string {
  try { return new URL(input).hostname; } catch { return input.toLowerCase(); }
}

function looksLikeCountry(subject: string): boolean {
  const s = subject.trim().toLowerCase();
  return /\b(usa|u\.s\.a|united states|us|uk|united kingdom|england|scotland|wales|ireland|canada|mexico|france|germany|spain|italy|eu|europe|china|japan|india|australia|new zealand)\b/.test(s);
}

function preScoreOverride(domain: string, subject: string): number | null {
  const host = hostFrom(domain);
  const isGov = /(^|\.)gov(\.|$)/.test(host) || host.endsWith('.gov.uk') || host.endsWith('.europa.eu') || host.endsWith('usembassy.gov');
  const isEmbassy = host.includes('embassy') || host.includes('consulate') || host.endsWith('usembassy.gov');
  const isBooking = /(booking|expedia|kayak|skyscanner|tripadvisor|seatguru|schengenvisainfo)\./.test(host);
  const isAirlineOrHotel = /(delta|united|american|jetblue|alaska|spirit|frontier|emirates|qatar|lufthansa|airfrance|britishairways|marriott|hilton|hyatt|ihg)\./.test(host);

  if (looksLikeCountry(subject)) {
    if (isGov || isEmbassy) return 0.95; // official
    if (isBooking) return 0.2;          // not official
    if (isAirlineOrHotel) return 0.1;   // brand is not official for country policy
  }
  return null;
}

export async function scoreDomainAuthenticity(
  domain: string, 
  airlineName: string,
  signal?: AbortSignal
): Promise<DomainScore> {
  // AI-first: rely on the LLM-driven classifier prompt to decide
  const confidence = await classifyWithLLM(domain, airlineName);
  return {
    domain,
    confidence,
    reasoning: 'llm_classified',
    isOfficial: confidence >= 0.6
  };
}
