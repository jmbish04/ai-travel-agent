import {
  searchTravelInfo,
  llmExtractAttractionsFromResults,
  getSearchSource,
} from './search.js';
import { fetchJSON, ExternalFetchError } from '../util/fetch.js';
import { searchPOIs, getPOIDetail } from './opentripmap.js';
type AttractionItem = { name: string; description?: string };
import { callLLM } from '../core/llm.js';
import { getPrompt } from '../core/prompts.js';
import { observeExternal } from '../util/metrics.js';
import type pino from 'pino';

// Semantic attraction filtering
function isValidAttraction(name: string): boolean {
  const excluded = new Set([
    'restaurant', 'cafe', 'pizzeria', 'bar', 'grill', 'fountain', 
    'erg', '320 gradi', 'tōkaidō', 'road', 'street', 'avenue'
  ]);
  const lower = name.toLowerCase();
  return !excluded.has(lower) && !Array.from(excluded).some(term => lower.includes(term));
}

type Out = { ok: true; summary: string; source?: string; reason?: string } | { ok: false; reason: string; source?: string };

type ToolCtx = { signal?: AbortSignal; log?: Pick<pino.Logger, 'debug' | 'info' | 'warn' | 'error'> };

export async function getAttractions(
  input: { city?: string; limit?: number; profile?: 'default' | 'kid_friendly' },
  ctx: ToolCtx = {},
): Promise<Out> {
  const start = Date.now();
  
  if (!input.city) {
    observeExternal({
      target: 'attractions',
      status: 'error',
      query_type: 'no_city'
    }, Date.now() - start);
    return { ok: false, reason: 'no_city' };
  }
  
  // Check for obviously fake city names in the original input
  const city = input.city.toLowerCase();
  if (city.includes('fake') || city.includes('test') || city.includes('cityville') || 
      city.includes('ville') && city.length < 15 || city.length <= 2) {
    observeExternal({
      target: 'attractions',
      status: 'error',
      query_type: 'invalid_city',
      location: input.city
    }, Date.now() - start);
    return { ok: false, reason: 'unknown_city' };
  }
  
  const category = input.profile || 'default';
  
  try {
    // Try OpenTripMap first for richer POI data
    const primaryResult = await tryOpenTripMap(input.city, input.limit, input.profile, ctx);
    if (primaryResult.ok) {
      observeExternal({
        target: 'attractions',
        status: 'ok',
        query_type: 'opentripmap',
        location: input.city,
        domain: category
      }, Date.now() - start);
      return primaryResult;
    }

    // For unknown cities, avoid web fallback to prevent fabrications
    if (!primaryResult.ok && 'reason' in primaryResult && primaryResult.reason === 'unknown_city') {
      observeExternal({
        target: 'attractions',
        status: 'error',
        query_type: 'unknown_city',
        location: input.city,
        domain: category
      }, Date.now() - start);
      return primaryResult;
    }

    // Fallback to web search
    const fallbackResult = await tryAttractionsFallback(input.city, ctx);
    
    observeExternal({
      target: 'attractions',
      status: fallbackResult.ok ? 'ok' : 'error',
      query_type: 'search_fallback',
      location: input.city,
      domain: category
    }, Date.now() - start);
    
    if (fallbackResult.ok) {
      return { ...fallbackResult, source: getSearchSource() };
    }

    return primaryResult; // Return original error
  } catch (error) {
    observeExternal({
      target: 'attractions',
      status: 'error',
      query_type: 'exception',
      location: input.city,
      domain: category
    }, Date.now() - start);
    throw error;
  }
}

async function tryOpenTripMap(city: string, limit = 7, profile: 'default' | 'kid_friendly' = 'default', ctx: ToolCtx = {}): Promise<Out> {
  // Resolve city to coordinates via Open-Meteo Geocoding API
  type GeoItem = {
    name?: string;
    latitude?: number;
    longitude?: number;
  };
  type GeoResp = { results?: GeoItem[] };
  try {
    const g = await fetchJSON<GeoResp>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        city,
      )}&count=1&language=en&format=json`,
      { timeoutMs: 4000, retries: 2, target: 'open-meteo:geocode' },
    );
    const first = (g.results ?? [])[0];
    if (!first || typeof first.latitude !== 'number' || typeof first.longitude !== 'number') {
      return { ok: false, reason: 'unknown_city' };
    }
    
    // Use valid OpenTripMap categories (tested against API)
    const baseKinds = [
      'interesting_places','cultural','historic','architecture','museums',
      'churches','monuments','castles','towers','bridges','other'
    ];
    const kidKinds = [
      'interesting_places','museums','amusements','sport'
    ];

    const kinds = (profile === 'kid_friendly' ? kidKinds : baseKinds)
      .filter(k => !['restaurants','eateries','bars','cafes'].includes(k))
      .join(',');

    const pois = await searchPOIs({ 
      lat: first.latitude, 
      lon: first.longitude, 
      limit: limit + 3, // Get more for better filtering
      kinds
    });
    
    if (pois.ok && pois.pois.length >= 2) {
      // Get detailed descriptions for NLP classification
      const top = pois.pois.slice(0, Math.max(5, Math.min(limit + 2, 8)));
      // Fetch details with small concurrency to reduce wall time
      const concurrency = 3;
      const queue = [...top];
      const attractions: AttractionItem[] = [];
      const workers: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i++) {
        workers.push((async () => {
          while (queue.length > 0) {
            const p = queue.shift();
            if (!p) break;
            try {
              const d = await getPOIDetail(p.xid);
              const name = (d.ok ? d.detail.name : null) || p.name || '';
              const description = d.ok ? (d.detail.description || '').replace(/\s+/g, ' ').trim() : '';
              if (name && name.length >= 3 && isValidAttraction(name)) {
                attractions.push({ name, description });
              }
            } catch {
              // ignore individual detail failures
            }
          }
        })());
      }
      await Promise.allSettled(workers);
      
      if (attractions.length >= 1) {
        // For kid_friendly, apply lightweight LLM-based classification; otherwise keep all
        const finalAttractions = profile === 'kid_friendly'
          ? await batchFilterKidFriendly(attractions, ctx)
          : attractions;
        
        if (finalAttractions.length >= 1) {
          const summary = await summarizeAttractions(finalAttractions.slice(0, limit), city, profile, ctx);
          return { ok: true, summary, source: 'opentripmap' };
        }
      }
    }
    
    // Second pass with city center radius if first pass yielded insufficient results
    if (pois.ok && pois.pois.length < 3) {
      const poisRadius = await searchPOIs({ 
        lat: first.latitude, 
        lon: first.longitude, 
        limit: limit + 2,
        kinds: (profile === 'kid_friendly' ? kidKinds : baseKinds)
          .filter(k => !['restaurants','eateries','bars','cafes'].includes(k))
          .join(','),
        radiusMeters: 5000 // 5km radius
      });
      
      if (poisRadius.ok && poisRadius.pois.length > 0) {
        const attractions: AttractionItem[] = poisRadius.pois
          .slice(0, Math.max(3, Math.min(limit, 6)))
          .map(p => ({ name: (p.name || '').trim(), description: '' }))
          .filter(a => a.name.length >= 5)
          .filter(a => isValidAttraction(a.name));
          
        if (attractions.length > 0) {
          const finalAttractions = profile === 'kid_friendly'
            ? await batchFilterKidFriendly(attractions, ctx)
            : attractions;
          
          if (finalAttractions.length > 0) {
            const summary = await summarizeAttractions(finalAttractions, city, profile, ctx);
            return { ok: true, summary, source: 'opentripmap' };
          }
        }
      }
    }
    
    if (pois.ok) {
      return { ok: false, reason: 'no_pois', source: 'opentripmap' };
    }
    return { ok: false, reason: 'reason' in pois ? pois.reason : 'unknown_error', source: pois.source || 'opentripmap' };
  } catch (e) {
    if (e instanceof ExternalFetchError) {
      return { ok: false, reason: e.kind === 'timeout' ? 'timeout' : 'network', source: 'opentripmap' };
    }
    return { ok: false, reason: 'network', source: 'opentripmap' };
  }
}

async function tryAttractionsFallback(city: string, _ctx: ToolCtx = {}): Promise<Out> {
  const query = `top attractions in ${city} things to do visit`;

  const searchResult = await searchTravelInfo(query);
  if (!searchResult.ok) {
    return { ok: false, reason: 'fallback_failed', source: getSearchSource() };
  }

  // LLM-first extraction
  const attractionsInfoLLM = await llmExtractAttractionsFromResults(searchResult.results, city);
  if (attractionsInfoLLM) {
    return { ok: true, summary: attractionsInfoLLM, source: getSearchSource() };
  }

  return { ok: false, reason: 'no_attractions_data', source: getSearchSource() };
}

/**
 * Summarize attractions using LLM for coherent output
 */
async function summarizeAttractions(
  attractions: AttractionItem[], 
  city: string, 
  profile: 'default' | 'kid_friendly' = 'default',
  ctx: ToolCtx = {}
): Promise<string> {
  // Allow disabling tool-side summarizers for latency
  if ((process.env.ENABLE_TOOL_SUMMARIZERS || 'false').toLowerCase() !== 'true') {
    const items = attractions.map(a => `- ${a.name}`).join('\n');
    return `Kid‑friendly attractions in ${city}:\n${items}`;
  }
  try {
    const attractionData = attractions.map(a => ({
      name: a.name,
      description: a.description || 'No description available'
    }));

    const profileContext = profile === 'kid_friendly' 
      ? 'Focus on family-friendly and child-appropriate attractions.'
      : 'Include all types of attractions for general travelers.';

    const tpl = await getPrompt('attractions_summarizer');
    const prompt = tpl
      .replace('{city}', city)
      .replace('{profileContext}', profileContext)
      .replace(
        '{attractions}',
        attractionData
          .map(a => `- ${a.name}: ${a.description.slice(0, 200)}`)
          .join('\n'),
      );

    const response = await callLLM(prompt, { responseFormat: 'json', timeoutMs: 1800, signal: ctx.signal, log: ctx.log });
    const parsed = JSON.parse(response);
    
    if (parsed.summary && typeof parsed.summary === 'string') {
      return parsed.summary;
    }
    
    // Fallback to simple list if LLM fails
    return `Popular attractions in ${city} include: ${attractions.map(a => a.name).join(', ')}`;
    
  } catch (error) {
    // Fallback to simple list if LLM fails
    return `Popular attractions in ${city} include: ${attractions.map(a => a.name).join(', ')}`;
  }
}

/**
 * Lightweight kid‑friendly filter using LLM prompt; no Transformers.
 */
async function batchFilterKidFriendly(items: AttractionItem[], ctx: ToolCtx = {}): Promise<AttractionItem[]> {
  if (items.length <= 2) return items; // trivial case
  const tpl = await getPrompt('attractions_kid_friendly');
  const input = items.map((a, i) => ({ i, name: a.name, description: (a.description || '').slice(0, 240) }));
  const joined = input.map(a => `#${a.i} ${a.name}: ${a.description || ''}`).join('\n');
  // Extend the prompt to request array classification
  const batched = `${tpl}\nClassify the following list. Return strict JSON: { "keep": number[] } where numbers are the #ids to keep.\n\n${joined}`;
  try {
    const raw = await callLLM(batched, { responseFormat: 'json', timeoutMs: 1500, signal: ctx.signal, log: ctx.log });
    const parsed = JSON.parse(raw) as { keep?: number[] };
    const keep = Array.isArray(parsed.keep) ? new Set(parsed.keep) : new Set<number>();
    const filtered = items.filter((_, idx) => keep.has(idx));
    if (filtered.length > 0) return filtered;
  } catch {}
  // Fallback: keep up to 3 items when classification fails
  return items.slice(0, Math.min(3, items.length));
}
