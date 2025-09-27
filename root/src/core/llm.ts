import 'dotenv/config';
import { z } from 'zod';
import { getContext } from './memory.js';
import { fetch as undiciFetch } from 'undici';
import { getPrompt } from './prompts.js';
import { observeLLMRequest, addMetaTokens } from '../util/metrics.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { CIRCUIT_BREAKER_CONFIG } from '../config/resilience.js';
import type { Logger } from 'pino';

// Declare global process for Node.js environment
declare const process: NodeJS.Process;

// Circuit breaker for LLM API calls
const llmCircuitBreaker = new CircuitBreaker(CIRCUIT_BREAKER_CONFIG, 'llm');

type ResponseFormat = 'text' | 'json';

// Lightweight in-memory cache to avoid duplicate LLM calls for identical prompts
const LLM_CACHE = new Map<string, { ts: number; value: string }>();
function cacheGet(model: string, format: ResponseFormat, prompt: string): string | undefined {
  const ttlMs = Math.max(0, Number(process.env.LLM_CACHE_TTL_MS ?? '15000'));
  const key = `${model}::${format}::${prompt}`;
  const hit = LLM_CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > ttlMs) { LLM_CACHE.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(model: string, format: ResponseFormat, prompt: string, value: string) {
  const key = `${model}::${format}::${prompt}`;
  const max = Math.max(1, Number(process.env.LLM_CACHE_MAX ?? '64'));
  if (LLM_CACHE.size >= max) {
    // evict oldest
    let oldestKey: string | undefined; let oldestTs = Infinity;
    for (const [k, v] of LLM_CACHE.entries()) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; } }
    if (oldestKey) LLM_CACHE.delete(oldestKey);
  }
  LLM_CACHE.set(key, { ts: Date.now(), value });
}

// Unified content classification schema
const ContentClassificationSchema = z.object({
  content_type: z.enum(['travel', 'system', 'policy', 'unrelated', 'budget', 'restaurant', 'flight', 'gibberish', 'emoji_only']),
  is_explicit_search: z.boolean(),
  has_mixed_languages: z.boolean().optional().default(false),
  needs_web_search: z.boolean().optional().default(false),
  categories: z.array(z.string()).optional().default([]),
  confidence: z.number().min(0).max(1).optional().default(0.5)
});

export type ContentClassification = z.infer<typeof ContentClassificationSchema>;

export type IntentClassification = {
  intent: 'weather' | 'packing' | 'attractions' | 'destinations' | 'flights' | 'web_search' | 'unknown';
  confidence: number;
  needExternal: boolean;
  slots?: Record<string, unknown>;
};

// Simple token counter (approximate, for logs only)
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function numFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function buildGenParams(format: ResponseFormat, kind: 'plain' | 'tools') {
  // Temperature
  const baseTemp = numFromEnv('LLM_TEMPERATURE');
  const jsonTemp = numFromEnv('LLM_TEMPERATURE_JSON');
  const toolsTemp = numFromEnv('LLM_TOOLS_TEMPERATURE');
  const temperature = kind === 'tools'
    ? (toolsTemp ?? baseTemp ?? 0.2)
    : (format === 'json' ? (jsonTemp ?? baseTemp ?? 0.2) : (baseTemp ?? 0.5));
  // Max output tokens (omit if not provided to allow provider defaults)
  const maxTokens = kind === 'tools' ? (numFromEnv('LLM_TOOLS_MAX_TOKENS') ?? numFromEnv('LLM_MAX_TOKENS'))
                                     : numFromEnv('LLM_MAX_TOKENS');
  // Sampling controls
  const topP = numFromEnv('LLM_TOP_P');
  const topK = numFromEnv('LLM_TOP_K');
  return { temperature, maxTokens, topP, topK };
}

export async function callLLM(
  prompt: string,
  _opts: { responseFormat?: ResponseFormat; log?: any; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const trimmed = prompt?.trim?.() ?? '';
  if (!trimmed) {
    const format: ResponseFormat = _opts.responseFormat ?? 'text';
    if (_opts.log?.debug) _opts.log.debug('⚠️ callLLM received empty prompt, returning stub');
    return format === 'json' ? '{}' : '';
  }
  const jsonHint = /strict JSON|Return strict JSON|Output \(strict JSON only\)/i.test(prompt);
  const format: ResponseFormat = _opts.responseFormat ?? (jsonHint ? 'json' : 'text');
  const log = _opts.log;

  const inputTokens = countTokens(prompt);
  if (log) log.debug(`🤖 LLM Call - Input: ${inputTokens} tokens, Format: ${format}`);
  
  // Model fallback chain from env or default
  const defaultModels = [
    'mistralai/mistral-nemo',
    'tngtech/deepseek-r1t2-chimera:free',
    'meta-llama/llama-3.2-3b-instruct:free',
    'microsoft/phi-3-mini-128k-instruct:free'
  ];
  const models = process.env.LLM_MODELS?.split(',').map((m: string) => m.trim()) || defaultModels;
  
  // Try configured provider first
  const baseUrl = process.env.LLM_PROVIDER_BASEURL;
  const apiKey = process.env.LLM_API_KEY;
  const preferredModel = process.env.LLM_MODEL ?? models[0];

  if (baseUrl && apiKey && preferredModel) {
    // Try preferred model first
    const result = await tryModel(baseUrl, apiKey, preferredModel, prompt, format, log || undefined, _opts.timeoutMs, _opts.signal);
    if (result) return result;
    
    // Fallback to other models
    for (const model of models) {
      if (model !== preferredModel) {
        const result = await tryModel(baseUrl, apiKey, model, prompt, format, log || undefined, _opts.timeoutMs, _opts.signal);
        if (result) return result;
      }
    }
  }

  // Try OpenRouter fallback
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    for (const model of models) {
      const result = await tryModel('https://openrouter.ai/api/v1', openrouterKey, model, prompt, format, log || undefined, _opts.timeoutMs, _opts.signal);
      if (result) return result;
    }
  }

  if (log) log.warn('All LLM providers failed, using stub');
  return stubSynthesize(prompt);
}

async function tryModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  format: ResponseFormat,
  log?: any,
  timeoutMs: number = 2500,
  externalSignal?: AbortSignal
): Promise<string | null> {
  try {
    if (log?.debug) log.debug(`🔗 Trying model: ${model} at ${baseUrl}`);
    // Cache check
    const cached = cacheGet(model, format, prompt);
    if (cached) {
      if (log?.debug) log.debug('⚡ LLM cache hit');
      return cached;
    }
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    
    const result = await llmCircuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('llm_timeout')), Math.max(500, timeoutMs));
      // If caller provided a signal, link it to our internal timeout controller
      const signal = externalSignal ? (AbortSignal as any).any?.([controller.signal, externalSignal]) || controller.signal : controller.signal;
      const reqStart = Date.now();
      const params = buildGenParams(format, 'plain');
      const body: any = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: params.temperature,
        ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        ...(params.topP !== undefined ? { top_p: params.topP } : {}),
        ...(params.topK !== undefined ? { top_k: params.topK } : {}),
        ...(format === 'json' ? { response_format: { type: 'json_object' } } : {}),
      };
      const res = await undiciFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      clearTimeout(timer);
      try {
        const provider = ((): string => { try { return new URL(baseUrl).hostname || 'custom'; } catch { return 'custom'; } })();
        const latency = Date.now() - reqStart;
        observeLLMRequest(provider, model, 'chat', latency);
      } catch {}
      
      if (!res.ok) {
        const errorText = await res.text();
        if (log?.debug) log.debug(`❌ Model ${model} failed: ${res.status} - ${errorText.substring(0, 200)}`);
        throw new Error(`HTTP ${res.status}: ${errorText.substring(0, 100)}`);
      }
      
      return res;
    });
    
    const data = (await result.json()) as { 
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data?.choices?.[0]?.message?.content ?? '';
    try {
      if (data?.usage) {
        addMetaTokens(Math.max(0, data.usage.prompt_tokens || 0), Math.max(0, data.usage.completion_tokens || 0));
      }
    } catch {}
    
    if (typeof content === 'string' && content.trim().length > 0) {
      if (log?.debug) log.debug(`✅ Model ${model} succeeded - Output: ${countTokens(content)} tokens`);
      const out = content.trim();
      cacheSet(model, format, prompt, out);
      return out;
    }
    
    if (log?.debug) log.debug(`❌ Model ${model} returned empty content`);
    return null;
  } catch (e) {
    // Handle circuit breaker errors
    if (e instanceof Error && e.name === 'CircuitBreakerError') {
      if (log?.debug) log.debug(`🔌 Model ${model} circuit breaker is open`);
      return null;
    }
    
    if (log?.debug) log.debug(`❌ Model ${model} error: ${String(e)}`);
    return null;
  }
}

/**
 * Try to extract a JSON object from an LLM response safely.
 * Returns undefined if no valid JSON object can be found.
 */
export function safeExtractJson(text: string): unknown | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}

function stubSynthesize(prompt: string): string {
  // When LLM is unavailable, return appropriate fallback responses
  
  // If this is a router prompt, return basic JSON
  if (prompt.includes('Return STRICT JSON') && prompt.includes('intent')) {
    return JSON.stringify({
      intent: 'unknown',
      confidence: 0.3,
      needExternal: false,
      slots: {}
    });
  }
  
  // If this is a content classification prompt, return basic JSON
  if (prompt.includes('content_type') && prompt.includes('is_explicit_search')) {
    return JSON.stringify({
      content_type: 'travel',
      is_explicit_search: false,
      has_mixed_languages: false,
      needs_web_search: false
    });
  }
  
  // For regular chat responses, throw error instead of returning error message
  throw new Error("LLM service temporarily unavailable");
}

// OpenAI-style chat with tools (function calling)
export async function chatWithToolsLLM(opts: {
  messages: Array<{ role: 'system'|'user'|'assistant'|'tool'; content: string; name?: string; tool_call_id?: string }>;
  tools: Array<{ type: 'function'; function: { name: string; description?: string; parameters: unknown } }>;
  tool_choice?: 'auto' | { type: 'function'; function: { name: string } };
  timeoutMs?: number;
  log?: any;
  signal?: AbortSignal;
}): Promise<any> {
  const baseUrl = process.env.LLM_PROVIDER_BASEURL;
  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  const model = process.env.LLM_MODEL || 'x-ai/grok-4-fast:free';
  
  opts.log?.debug?.({ 
    baseUrl: !!baseUrl,
    hasApiKey: !!apiKey,
    model,
    messagesCount: opts.messages?.length || 0,
    toolsCount: opts.tools?.length || 0,
    timeoutMs: opts.timeoutMs,
    hasSignal: !!opts.signal
  }, '🔧 LLM: Starting chatWithToolsLLM');
  
  if (!baseUrl || !apiKey) {
    opts.log?.error?.({ baseUrl: !!baseUrl, hasApiKey: !!apiKey }, '🔧 LLM: Missing baseUrl or apiKey');
    // Return empty response to trigger local fallback
    return { choices: [{ message: { role: 'assistant', content: '' } }] };
  }
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const internalController = new AbortController();
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? 15000);
  const timeoutHandle = setTimeout(() => {
    opts.log?.error?.({ timeoutMs }, '🔧 LLM: Timeout reached, aborting request');
    internalController.abort(new Error('llm_tools_timeout'));
  }, timeoutMs);
  // Combine caller signal with our internal timeout signal (Node 20 supports AbortSignal.any)
  const combinedSignal: AbortSignal = (AbortSignal as any)?.any?.(
    [internalController.signal, opts.signal].filter(Boolean)
  ) || (opts.signal ?? internalController.signal);
  
  const gen = buildGenParams('text', 'tools');
  const requestBody: any = {
    model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: opts.tool_choice || 'auto',
    temperature: gen.temperature,
    ...(gen.maxTokens !== undefined ? { max_tokens: gen.maxTokens } : {}),
    ...(gen.topP !== undefined ? { top_p: gen.topP } : {}),
    ...(gen.topK !== undefined ? { top_k: gen.topK } : {}),
  };
  
  opts.log?.debug?.({ 
    url,
    model,
    messagesLength: JSON.stringify(opts.messages).length,
    toolsLength: JSON.stringify(opts.tools).length,
    requestBodySize: JSON.stringify(requestBody).length
  }, '🔧 LLM: Making request to LLM API');
  
  try {
    const requestStart = Date.now();
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: combinedSignal,
    });
    // We have a response; cancel the timeout immediately to avoid stray aborts/logs
    clearTimeout(timeoutHandle);
    const requestLatency = Date.now() - requestStart;
    try {
      const provider = ((): string => { try { return new URL(baseUrl).hostname || 'custom'; } catch { return 'custom'; } })();
      observeLLMRequest(provider, model, 'tool', requestLatency);
    } catch {}
    
    opts.log?.debug?.({ 
      status: res.status,
      ok: res.ok,
      requestLatency,
      hasResponse: !!res
    }, '🔧 LLM: Received response from LLM API');
    
    if (!res.ok) {
      const errorText = await res.text();
      opts.log?.error?.({ 
        status: res.status,
        errorText: errorText.substring(0, 500),
        requestLatency
      }, '🔧 LLM: chatWithToolsLLM failed with non-OK status');
      // Return explicit error envelope so callers can branch correctly
      return { error: { status: res.status, body: errorText }, choices: [] };
    }
    const data = await res.json() as any;
    
    opts.log?.debug?.({ 
      choicesCount: data.choices?.length || 0,
      hasMessage: !!data.choices?.[0]?.message,
      messageContent: data.choices?.[0]?.message?.content?.substring(0, 200),
      hasToolCalls: !!data.choices?.[0]?.message?.tool_calls,
      toolCallsCount: data.choices?.[0]?.message?.tool_calls?.length || 0,
      requestLatency
    }, '🔧 LLM: Successfully parsed LLM response');
    try {
      if (data?.usage) {
        addMetaTokens(Math.max(0, data.usage.prompt_tokens || 0), Math.max(0, data.usage.completion_tokens || 0));
      }
    } catch {}
    
    return data;
  } catch (e) {
    const isAbortError = e instanceof Error && (e.name === 'AbortError' || e.message.includes('abort'));
    const isTimeoutError = e instanceof Error && e.message.includes('timeout');
    
    opts.log?.error?.({ 
      error: String(e),
      errorName: e instanceof Error ? e.name : 'unknown',
      isAbortError,
      isTimeoutError,
      timeoutMs
    }, '🔧 LLM: chatWithToolsLLM error occurred');
    
    // Return explicit error envelope instead of empty content
    return { error: { message: String(e) }, choices: [] };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// NLP Service Functions
export async function extractCityWithLLM(
  message: string,
  log?: any,
): Promise<string> {
  try {
    const promptTemplate = await getPrompt('nlp_city_extraction');
    const prompt = promptTemplate.replace('{message}', message);
    const response = await callLLM(prompt, { log });
    return response.trim();
  } catch (error) {
    if (log) log.debug('LLM city extraction failed, using fallback');
    return fallbackExtractCity(message);
  }
}

export async function generateClarifyingQuestion(
  missingSlots: string[],
  context: Record<string, string> = {},
  log?: any,
): Promise<string> {
  try {
    const promptTemplate = await getPrompt('nlp_clarifier');
    const prompt = promptTemplate
      .replace('{missing_slots}', JSON.stringify(missingSlots))
      .replace('{context}', JSON.stringify(context));
    const response = await callLLM(prompt, { log });
    return response.trim();
  } catch (error) {
    if (log) log.debug('LLM clarification failed, using fallback');
    return fallbackBuildClarifyingQuestion(missingSlots, context);
  }
}

export async function classifyIntent(
  message: string,
  context: Record<string, string> = {},
  log?: any,
): Promise<IntentClassification | null> {
  try {
    const promptTemplate = await getPrompt('nlp_intent_detection');
    const prompt = promptTemplate
      .replace('{message}', message)
      .replace('{context}', JSON.stringify(context));
    const response = await callLLM(prompt, { responseFormat: 'json', log });
    const parsed = JSON.parse(response);
    const out: IntentClassification = {
      intent: parsed.intent,
      confidence: parsed.confidence,
      needExternal: parsed.needExternal,
      slots: typeof parsed.slots === 'object' && parsed.slots ? parsed.slots : undefined,
    };
    return out;
  } catch (error) {
    if (log) log.debug('LLM intent classification failed');
    return null;
  }
}

export async function classifyContent(
  message: string,
  log?: any,
): Promise<ContentClassification | null> {
  try {
    const promptTemplate = await getPrompt('nlp_content_classification');
    const prompt = promptTemplate.replace('{message}', message);
    const response = await callLLM(prompt, { responseFormat: 'json', log });
    
    if (log?.debug) {
      log.debug({ 
        message: message.substring(0, 120), 
        response: response.substring(0, 120),
        responseType: typeof response 
      }, 'content_classification_response');
    }
    
    // Parse JSON response with Zod schema validation
    let parsed: unknown;
    try {
      parsed = JSON.parse(response);
    } catch {
      // Fallback: extract JSON from response if wrapped in text
      const extracted = safeExtractJson(response);
      if (!extracted) {
        if (log?.debug) log.debug({ response }, 'content_classification_no_json_found');
        return null;
      }
      parsed = extracted;
    }
    
    // Validate with Zod schema
    const result = ContentClassificationSchema.safeParse(parsed);
    if (!result.success) {
      if (log?.debug) log.debug({ 
        parsed, 
        errors: result.error.errors 
      }, 'content_classification_schema_validation_failed');
      return null;
    }
    
    return result.data;
  } catch (error) {
    if (log?.debug) log.debug({ 
      error: String(error), 
      message: message.substring(0, 120) 
    }, 'content_classification_failed');
    return null;
  }
}

// Fallback functions for when LLM fails
function fallbackExtractCity(text: string): string {
  const patterns = [
    /\b(?:in|to|for|from)\s+([A-Z][A-Za-z\- ]+(?:\s+[A-Z][A-Za-z\- ]+)*)/,
    /\b([A-Z][A-Za-z\- ]+(?:\s+[A-Z][A-Za-z\- ]+)*)\s+(?:in|on|for|during)\s+\w+/,
    /(?:pack|weather|visit|go|travel)\s+(?:for|to|in)\s+([A-Z][A-Za-z\- ]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const city = match[1].split(/[.,!?]/)[0]?.trim();
      if (city) {
        // Handle abbreviations
        const abbrevMap: Record<string, string> = {
          'NYC': 'New York',
          'SF': 'San Francisco', 
          'LA': 'Los Angeles',
          'BOS': 'Boston',
        };
        return abbrevMap[city] || city;
      }
    }
  }
  return '';
}

// Simple query optimization cache
const queryCache = new Map<string, string>();

export async function optimizeSearchQuery(
  query: string,
  context: Record<string, string> = {},
  intent: string = 'unknown',
  log?: any,
): Promise<string> {
  // Enhanced context prioritization: if new location is mentioned, prioritize it
  const currentLocation = context.city || context.destinationCity;
  const contextKey = currentLocation ? `${currentLocation}:${intent}` : `${intent}:${JSON.stringify(context)}`;
  const cacheKey = `${query}:${contextKey}`;
  
  if (queryCache.has(cacheKey)) {
    if (log) log.debug({ currentLocation, intent }, 'Using cached optimized query');
    return queryCache.get(cacheKey)!;
  }

  try {
    const promptTemplate = await getPrompt('search_query_optimizer');
    
    // Enhanced context with location priority
    const enhancedContext = currentLocation 
      ? { ...context, primaryLocation: currentLocation }
      : context;
    
    const prompt = promptTemplate
      .replace('{query}', query)
      .replace('{context}', JSON.stringify(enhancedContext))
      .replace('{intent}', intent);
    
    const response = await callLLM(prompt, { log });
    let optimized = response.trim();
    
    // Remove quotes that LLM might add
    optimized = optimized.replace(/^(?:["'])|(?:["'])$/g, '');
    
    // Ensure current location is included if not already present
    if (currentLocation && !optimized.toLowerCase().includes(currentLocation.toLowerCase())) {
      optimized = `${currentLocation} ${optimized}`;
    }
    
    // Validate length constraint (≤12 words)
    const wordCount = optimized.split(/\s+/).filter(Boolean).length;
    if (wordCount > 12) {
      // Truncate to first 12 words (branches were identical)
      const words = optimized.split(/\s+/).filter(Boolean);
      optimized = words.slice(0, 12).join(' ');
    }
    
    // Cache the result
    queryCache.set(cacheKey, optimized);
    
    if (log) {
      log.debug({ 
        original: query, 
        optimized, 
        currentLocation, 
        intent 
      }, '🔍 Query optimized with location context');
    }
    
    // Limit cache size
    if (queryCache.size > 100) {
      const firstKey = queryCache.keys().next().value;
      if (firstKey) {
        queryCache.delete(firstKey);
      }
    }
    
    if (log) log.debug({ original: query, optimized, wordCount }, 'query_optimized');
    return optimized;
  } catch (error) {
    if (log) log.debug('Query optimization failed, using fallback');
    const fallback = fallbackOptimizeQuery(query);
    // If fallback also fails, use original query instead of error message
    return fallback || query;
  }
}

function fallbackOptimizeQuery(query: string): string {
  // Simple fallback: remove common filler words and truncate
  const fillerWords = ['what', 'is', 'the', 'a', 'an', 'how', 'can', 'you', 'tell', 'me', 'about', 'some', 'good', 'best'];
  const words = query.toLowerCase().split(/\s+/)
    .filter(word => !fillerWords.includes(word) && word.length > 2)
    .slice(0, 7);
  
  return words.join(' ') || query.slice(0, 50);
}

export async function callLLMBatch(prompts: string[], opts: any): Promise<string[]> {
  if (prompts.length === 0) return [];
  const firstPrompt = prompts[0];
  if (prompts.length === 1 && firstPrompt) return [await callLLM(firstPrompt, opts)];
  
  // Simple batch: join with delimiters, one roundtrip, split back
  const sep = '\n\n---PROMPT_SPLIT---\n\n';
  const joined = prompts.join(sep);
  const out = await callLLM(joined, opts);
  return out.split(sep).map(s => s.trim());
}

function fallbackBuildClarifyingQuestion(
  missing: string[],
  slots: Record<string, string> = {},
): string {
  const miss = new Set(missing.map((m) => m.toLowerCase()));
  if (miss.has('dates') && miss.has('city')) {
    return 'Could you share the city and month/dates?';
  }
  if (miss.has('dates')) {
    return 'Which month or travel dates?';
  }
  if (miss.has('city')) {
    return 'Which city are you asking about?';
  }
  return 'Could you provide more details about your travel plans?';
}
