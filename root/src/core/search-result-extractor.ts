import { z } from 'zod';
import { callLLM } from './llm.js';
import { getPrompt } from './prompts.js';
import type pino from 'pino';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

const ExtractionSchema = z.object({
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  entities: z.array(z.object({
    text: z.string(),
    type: z.string(),
    value: z.string().optional(),
  })).optional().default([]),
  relevanceScore: z.number().min(0).max(1).optional(),
});

export type ExtractionResultT = {
  summary: string;
  confidence: number;
  aiMethod: 'llm' | 'fallback';
  entities?: Array<{ text: string; type: string; value?: string }>;
  relevanceScore?: number;
};

function escapeForPrompt(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatResults(results: SearchResult[]): string {
  return results
    .map((result, index) => {
      const title = result.title || 'Untitled';
      const snippet = result.description || '';
      const url = result.url || '';
      return `${index + 1}. Title: ${title}\nURL: ${url}\nSnippet: ${snippet}`;
    })
    .join('\n\n');
}

function fallbackExtraction(results: SearchResult[]): ExtractionResultT {
  const top = results[0];
  const summary = top ? top.description?.slice(0, 180) || top.title || 'No search results available' : 'No search results available';
  return {
    summary,
    confidence: 0.2,
    aiMethod: 'fallback',
    entities: [],
    relevanceScore: 0.2,
  };
}

export async function extractFromSearchResults(
  results: SearchResult[],
  query: string,
  extractionType: 'weather' | 'attractions' | 'country' | 'general' = 'general',
  log?: pino.Logger,
): Promise<ExtractionResultT> {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      summary: 'No search results available',
      confidence: 0.1,
      aiMethod: 'fallback',
      entities: [],
      relevanceScore: 0.1,
    };
  }

  try {
    const template = await getPrompt('search_result_extractor');
    const prompt = template
      .replace('{extractionType}', extractionType)
      .replace('{query}', escapeForPrompt(query))
      .replace('{results}', escapeForPrompt(formatResults(results.slice(0, 5))));

    const raw = await callLLM(prompt, { responseFormat: 'json', log });
    const parsed = ExtractionSchema.parse(JSON.parse(raw));

    return {
      summary: parsed.summary,
      confidence: parsed.confidence,
      aiMethod: 'llm',
      entities: parsed.entities,
      relevanceScore: parsed.relevanceScore ?? parsed.confidence,
    };
  } catch (error) {
    if (log?.debug) {
      log.debug({ error: String(error) }, 'llm_search_extraction_failed');
    }
    return fallbackExtraction(results);
  }
}
