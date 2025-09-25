import { z } from 'zod';
import Bottleneck from 'bottleneck';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import type pino from 'pino';
import { getWeather } from '../../tools/weather.js';
import { getCountryFacts } from '../../tools/country.js';
import { getAttractions } from '../../tools/attractions.js';
import { searchTravelInfo, getSearchCitation, getSearchSource } from '../../tools/search.js';
import { chatWithToolsLLM } from '../../core/llm.js';
import { resolveCity as amadeusResolveCityFn, airportsForCity as amadeusAirportsForCityFn } from '../../tools/amadeus_locations.js';
import { searchFlights as amadeusSearchFlights } from '../../tools/amadeus_flights.js';
import { incMetaToolCall, observeMetaToolLatency, incMetaParseFailure, addMetaTokens, setMetaRouteConfidence, noteMetaRoutingDecision, incMetaToolLedgerHit, incMetaToolSkippedByLedger, incMetaToolGatedSkip, incMetaToolError, observeStage, observeStageClarify } from '../../util/metrics.js';
import { VectaraClient } from '../../tools/vectara.js';
import { performDeepResearch } from '../../core/deep_research.js';
import { DestinationEngine } from '../../core/destination_engine.js';
import { processIrrops } from '../../core/irrops_engine.js';
import { PNRSchema, DisruptionEventSchema, UserPreferencesSchema } from '../../schemas/irrops.js';
import { parsePNRFromText } from '../../tools/pnr_parser.js';
import { deepResearchPages, extractPolicyWithCrawlee as extractPolicyPage } from '../../tools/crawlee_research.js';
import { assessQueryComplexity } from '../../core/complexity.js';
import { suggestPacking } from '../../tools/packing.js';

export type ToolCallContext = { signal?: AbortSignal };

export type ToolSpec = {
  name: string;
  description?: string;
  // Zod schema used for runtime validation
  schema: z.ZodTypeAny;
  // OpenAI-style tool spec derived from the schema
  spec: { type: 'function'; function: { name: string; description?: string; parameters: unknown } };
  call: (args: unknown, ctx: ToolCallContext) => Promise<unknown>;
};

// Shared limiter + retry policy
const limiter = new Bottleneck({ minTime: 100 });
const policy = retry(handleAll, { backoff: new ExponentialBackoff({ initialDelay: 200, maxDelay: 2000 }) });

// Minimal JSON Schema builders for our inputs (avoid extra deps)
const str = (desc?: string) => ({ type: 'string', description: desc });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const tools: ToolSpec[] = [
  {
    name: 'packingSuggest',
    description: 'Weather-grounded packing list blended with curated categories.',
    schema: z.object({
      city: z.string().min(1),
      month: z.string().optional(),
      dates: z.string().optional(),
      children: z.number().int().min(0).max(10).optional(),
      interests: z.array(z.string()).max(8).optional(),
    }),
    spec: { type: 'function', function: { name: 'packingSuggest', description: 'Packing list by city + dates/month', parameters: obj({ city: str('City'), month: str('Month (if known)'), dates: str('Dates (ISO or text)'), children: { type: 'integer', minimum: 0, maximum: 10 }, interests: { type: 'array', items: { type: 'string' } } }, ['city']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { city: string; month?: string; dates?: string; children?: number; interests?: string[] };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 9000);
      try {
        const out = await suggestPacking({ ...input }, controller.signal);
        if (out.ok) {
          const countBase = out.items.base.length;
          const countSpecial = Object.values(out.items.special).reduce((a, b) => a + b.length, 0);
          return { ok: true, summary: `${out.summary} (${out.band}) — ${countBase}+${countSpecial} items`, source: out.source, items: out.items, band: out.band };
        }
        return { ok: false, reason: out.reason };
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'extractPolicyWithCrawlee',
    description: 'Crawl a specific URL with Crawlee Playwright and extract an official policy clause with receipts.',
    schema: z.object({
      clause: z.enum(['baggage','refund','change','visa']),
      airlineName: z.string().min(2).optional(),
      timeoutMs: z.number().int().min(2000).max(90000).optional(),
      url: z.string().url().optional(),
      urls: z.array(z.string().url()).min(1).max(8).optional(),
    }).refine(v => !!v.url || (Array.isArray(v.urls) && v.urls.length > 0), { message: 'Provide url or urls[]' }),
    spec: { type: 'function', function: { name: 'extractPolicyWithCrawlee', description: 'Extract official policy clause from one or more URLs using Crawlee + Playwright', parameters: obj({ clause: { type: 'string', enum: ['baggage','refund','change','visa'] }, airlineName: str('Airline/brand name (optional)'), timeoutMs: { type: 'integer', minimum: 2000, maximum: 90000 }, url: str('Single target URL'), urls: { type: 'array', items: { type: 'string' }, description: 'Candidate URLs (on-brand preferred)' } }, ['clause']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { url?: string; urls?: string[]; clause: 'baggage'|'refund'|'change'|'visa'; airlineName?: string; timeoutMs?: number };
      const controller = new AbortController();
      const overallTimeout = Math.min(90000, Math.max(2000, input.timeoutMs ?? 30000));
      const to = setTimeout(() => controller.abort('timeout'), overallTimeout);
      try {
        const candidates = input.urls && input.urls.length ? input.urls : (input.url ? [input.url] : []);
        if (candidates.length === 0) throw new Error('no_urls');
        const start = Date.now();
        const perPage = Math.max(5000, Math.floor(overallTimeout / Math.min(5, candidates.length)));
        let best: any | undefined;
        for (const url of candidates.slice(0, 5)) {
          try {
            const rec = await extractPolicyPage({ url, clause: input.clause, airlineName: input.airlineName, timeoutMs: perPage, signal: controller.signal });
            if (!best || (rec.confidence ?? 0) > (best.confidence ?? 0)) best = rec;
            if ((rec.confidence ?? 0) >= 0.6 && rec.quote && rec.quote.length > 20) {
              return { ok: true, summary: `${rec.title}: ${String(rec.quote).slice(0, 180)}${rec.quote.length > 180 ? '…' : ''}`, source: rec.url, receipt: rec };
            }
          } catch (e) {
            // continue to next candidate
          }
          // Respect overall timeout budget
          if (Date.now() - start > overallTimeout - 750) break;
        }
        if (best) {
          return { ok: true, summary: `${best.title}: ${String(best.quote || '').slice(0, 180)}${(best.quote || '').length > 180 ? '…' : ''}`, source: best.url, receipt: best };
        }
        return { ok: false, reason: 'no_receipt' };
      } finally { clearTimeout(to); }
    }
  },
  {
    name: 'pnrParse',
    description: 'Parse free-form PNR text into a structured PNR object.',
    schema: z.object({ text: z.string().min(10) }),
    spec: { type: 'function', function: { name: 'pnrParse', description: 'Parse PNR text', parameters: obj({ text: str('Raw PNR text') }, ['text']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { text: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 4000);
      try {
        const pnr = await parsePNRFromText(input.text, controller.signal);
        if (pnr) return { ok: true, summary: `PNR parsed (${pnr.segments.length} segments)`, pnr };
        return { ok: false, reason: 'parse_failed' };
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'search',
    description: 'Web search for current travel info; returns results and optional deep summary.',
    schema: z.object({
      query: z.string().min(3),
      deep: z.boolean().optional()
    }),
    spec: { type: 'function', function: { name: 'search', description: 'Search the web for travel information', parameters: obj({ query: str('Search query string'), deep: { type: 'boolean', description: 'Enable deep research crawl' } }, ['query']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { query: string; deep?: boolean };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 9000);
      try {
        const out: any = await policy.execute(() => limiter.schedule(() => searchTravelInfo(input.query, undefined, !!input.deep)));
        if (out && out.ok) {
          // Normalize to include a summary + source so receipts capture facts
          const summary = out.deepSummary || `Search results (${getSearchSource()}): ${out.results?.length ?? 0} hits`;
          return { ...out, summary, source: getSearchCitation() };
        }
        return out;
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'vectaraQuery',
    description: 'Query policy/knowledge corpora with semantic search and citations.',
    schema: z.object({
      query: z.string().min(3),
      corpus: z.enum(['airlines','hotels','visas']),
      maxResults: z.number().int().min(1).max(20).optional(),
      filter: z.string().optional()
    }),
    spec: { type: 'function', function: { name: 'vectaraQuery', description: 'Semantic policy query with citations', parameters: obj({ query: str('Query text'), corpus: { type: 'string', enum: ['airlines','hotels','visas'] }, maxResults: { type: 'integer', minimum: 1, maximum: 20 }, filter: str('Optional metadata filter expression') }, ['query','corpus']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { query: string; corpus: 'airlines'|'hotels'|'visas'; maxResults?: number; filter?: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 12000);
      try {
        const client = new VectaraClient();
        const out = await client.query(input.query, { corpus: input.corpus, maxResults: input.maxResults, filter: input.filter });
        const summary = out.summary || (out.hits?.[0]?.snippet ? out.hits[0].snippet : '');

        // Prefer explicit Vectara identifiers so downstream receipts show corpus provenance.
        const citationsArr = Array.isArray(out.citations) ? out.citations : [];
        const hitsArr = Array.isArray(out.hits) ? out.hits : [];
        const primary = [...citationsArr, ...hitsArr].find((entry: any) => {
          return entry && (entry.documentId || entry.title);
        });
        const docId = primary?.documentId;
        const docTitle = primary?.title;
        const docLabel = docId ? `vectara:doc:${docId}` : docTitle ? `vectara:doc:${docTitle}` : 'vectara';

        const urlSet = new Set<string>();
        urlSet.add(docLabel);
        if (primary?.url) urlSet.add(primary.url);
        for (const c of citationsArr) {
          if (c?.url) urlSet.add(String(c.url));
        }
        for (const h of hitsArr) {
          if (h?.url) urlSet.add(String(h.url));
        }

        const citations = Array.from(urlSet).slice(0, 6);
        const source = docLabel;
        return { ok: true, summary, source, citations, raw: out };
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'deepResearch',
    description: 'Multi-pass web deep research with deduplication and synthesis.',
    schema: z.object({ query: z.string().min(3) }),
    spec: { type: 'function', function: { name: 'deepResearch', description: 'Deep research across the web with citations', parameters: obj({ query: str('Research question') }, ['query']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { query: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 15000);
      try {
        const out = await performDeepResearch(input.query, {}, undefined);
        return { ok: true, summary: out.summary, source: out.citations?.[0]?.source || 'web', citations: out.citations };
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'destinationSuggest',
    description: 'Suggest destinations by region/city preferences (safe defaults).',
    schema: z.object({ region: z.string().min(2).optional(), city: z.string().min(2).optional() }),
    spec: { type: 'function', function: { name: 'destinationSuggest', description: 'Get destination suggestions', parameters: obj({ region: str('Preferred region'), city: str('Seed city/preference') }) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { region?: string; city?: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 8000);
      try {
        const res = await DestinationEngine.getRecommendations({ region: input.region, city: input.city });
        const count = Array.isArray(res) ? res.length : 0;
        const names = Array.isArray(res) ? res.slice(0, 3).map((c: any) => c?.name?.common).filter(Boolean) : [];
        const summary = `Found ${count} candidate countries${names.length ? `; e.g., ${names.join(', ')}` : ''}`;
        return { ok: true, summary, source: 'rest-countries' };
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'irropsProcess',
    description: 'Process irregular operations (IRROPS) to suggest reroutes within policy constraints.',
    schema: z.object({
      pnr: PNRSchema,
      disruption: DisruptionEventSchema,
      preferences: UserPreferencesSchema.optional()
    }),
    spec: { type: 'function', function: { name: 'irropsProcess', description: 'Suggest IRROPS rebooking options', parameters: obj({ pnr: { type: 'object', description: 'PNR object' }, disruption: { type: 'object', description: 'Disruption event' }, preferences: { type: 'object', description: 'User preferences (optional)' } }, ['pnr','disruption']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { pnr: any; disruption: any; preferences?: any };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 12000);
      try {
        const options = await processIrrops(input.pnr, input.disruption, input.preferences || {}, controller.signal);
        const summary = `IRROPS: ${options.length} viable option(s)`;
        return { ok: true, summary, source: 'amadeus/policy', options };
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'weather',
    description: 'Get weather summary for a city (current, forecast, or month climate).',
    schema: z.object({ city: z.string().min(1), month: z.string().optional(), dates: z.string().optional() }),
    spec: { type: 'function', function: { name: 'weather', description: 'Weather by city with optional month or dates', parameters: obj({ city: str('City name'), month: str('Travel month (e.g., March)'), dates: str('Specific dates or relative (today/tomorrow)') }, ['city']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { city: string; month?: string; dates?: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 7000);
      try {
        return await policy.execute(() => limiter.schedule(() => getWeather({ city: input.city, month: input.month, dates: input.dates })));
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'getCountry',
    description: 'Get country facts (currency, language, region).',
    schema: z.object({ country: z.string().min(1) }).or(z.object({ city: z.string().min(1) })),
    spec: { type: 'function', function: { name: 'getCountry', description: 'Country info by country or city', parameters: obj({ country: str('Country name'), city: str('City name (to resolve country)') }) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { country?: string; city?: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 7000);
      try {
        return await policy.execute(() => limiter.schedule(() => getCountryFacts({ country: input.country, city: input.city })));
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'getAttractions',
    description: 'Get attractions summary for a city',
    schema: z.object({ city: z.string().min(1), limit: z.number().int().min(1).max(10).optional(), profile: z.enum(['default', 'kid_friendly']).optional() }),
    spec: { type: 'function', function: { name: 'getAttractions', description: 'Attractions for a city', parameters: obj({ city: str('City name'), limit: { type: 'integer', minimum: 1, maximum: 10 }, profile: { type: 'string', enum: ['default','kid_friendly'] } }, ['city']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { city: string; limit?: number; profile?: 'default'|'kid_friendly' };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 8000);
      try {
        return await policy.execute(() => limiter.schedule(() => getAttractions({ city: input.city, limit: input.limit, profile: input.profile })));
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'amadeusResolveCity',
    description: 'Resolve a city name to Amadeus city code (IATA) with confidence.',
    schema: z.object({ query: z.string().min(1), countryHint: z.string().min(2).optional() }),
    spec: { type: 'function', function: { name: 'amadeusResolveCity', description: 'Resolve city to IATA city code', parameters: obj({ query: str('City or location name'), countryHint: str('Optional ISO country code (2 letters)') }, ['query']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { query: string; countryHint?: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 7000);
      try {
        return await policy.execute(() => limiter.schedule(() => amadeusResolveCityFn(input.query, input.countryHint)));
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'amadeusAirportsForCity',
    description: 'List airports for a given IATA city code, sorted by traffic score.',
    schema: z.object({ cityCode: z.string().regex(/^[A-Z]{3}$/) }),
    spec: { type: 'function', function: { name: 'amadeusAirportsForCity', description: 'Airports for a city (IATA code)', parameters: obj({ cityCode: str('IATA city code, e.g., NYC') }, ['cityCode']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { cityCode: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 7000);
      try {
        return await policy.execute(() => limiter.schedule(() => amadeusAirportsForCityFn(input.cityCode, controller.signal)));
      } finally { clearTimeout(timeout); }
    }
  },
  {
    name: 'amadeusSearchFlights',
    description: 'Search flight offers between two locations (city/airport names or IATA).',
    schema: z.object({
      origin: z.string().min(3),
      destination: z.string().min(3),
      departureDate: z.string().min(1),
      returnDate: z.string().optional(),
      passengers: z.number().int().min(1).max(9).optional(),
      cabinClass: z.string().optional(),
    }),
    spec: { type: 'function', function: { name: 'amadeusSearchFlights', description: 'Search flights; resolves cities to IATA if needed', parameters: obj({ origin: str('City/airport or IATA'), destination: str('City/airport or IATA'), departureDate: str('ISO date yyyy-mm-dd or relative (today/tomorrow/next week)'), returnDate: str('Optional return date (ISO or relative)'), passengers: { type: 'integer', minimum: 1, maximum: 9 }, cabinClass: str('e.g., ECONOMY, PREMIUM_ECONOMY, BUSINESS, FIRST') }, ['origin','destination','departureDate']) } },
    async call(args: unknown) {
      const input = this.schema.parse(args) as { origin: string; destination: string; departureDate: string; returnDate?: string; passengers?: number; cabinClass?: string };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 12000);
      try {
        return await policy.execute(() => limiter.schedule(() => amadeusSearchFlights({ origin: input.origin, destination: input.destination, departureDate: input.departureDate, returnDate: input.returnDate, passengers: input.passengers, cabinClass: input.cabinClass })));
      } finally { clearTimeout(timeout); }
    }
  }
];

type ChatToolMsg = { role: 'system'|'user'|'assistant'|'tool'; content: string; name?: string; tool_call_id?: string };

// --- Execution ledger (per-turn) to dedupe/skips on repeated failures ---
function stableHash(input: unknown): string {
  try { return typeof input === 'string' ? input : JSON.stringify(input); } catch { return String(input); }
}
class ExecutionLedger {
  private map = new Map<string, { ok: boolean; http?: number; err?: string; ts: number }>();
  private successTtl = Number(process.env.LEDGER_SUCCESS_TTL_MS || 300000);
  private httpBlockTtl = Number(process.env.LEDGER_HTTP_BLOCK_TTL_MS || 900000);
  private zodFailTtl = Number(process.env.LEDGER_ZOD_FAIL_TTL_MS || 300000);
  private genericFailTtl = Number(process.env.LEDGER_FAIL_TTL_MS || 120000);
  key(tool: string, args: unknown) { return `${tool}:${stableHash(args)}`; }
  shouldSkip(tool: string, args: unknown): boolean {
    const k = this.key(tool, args);
    const e = this.map.get(k);
    if (!e) return false;
    const age = Date.now() - e.ts;
    if (e.ok) return age < this.successTtl;
    const ttl = (e.http === 403 || e.http === 429) ? this.httpBlockTtl
      : (e.err && e.err.includes('Zod')) ? this.zodFailTtl
      : this.genericFailTtl;
    return age < ttl;
  }
  finish(tool: string, args: unknown, outcome: { ok: boolean; http?: number; err?: string }) {
    const k = this.key(tool, args);
    this.map.set(k, { ...outcome, ts: Date.now() });
  }
}

function allowedToolsForRoute(route?: string): string[] {
  const all = tools.map(t => t.name);
  if (!route) return all;
  const lower = route.toLowerCase();
  if (lower === 'destinations' || lower === 'web' || lower === 'policy' || lower === 'visas') {
    return all.filter(n => !n.startsWith('amadeus'));
  }
  if (lower === 'packing') {
    // Packing must be tool-first (weather + curated). Do not deepResearch by default.
    return all.filter(n => n !== 'deepResearch');
  }
  return all;
}

export async function callChatWithTools(args: {
  system: string;
  attachments?: Array<{ name: string; content: string }>;
  user: string;
  context?: Record<string, unknown>;
  maxSteps?: number;
  timeoutMs?: number;
  log?: pino.Logger;
}): Promise<{ result: string; facts: Array<{ key: string; value: string; source?: string }>; decisions: Array<string>; citations: string[] }>
{
  const log = args.log;
  log?.debug?.({ 
    userMessage: args.user,
    contextKeys: Object.keys(args.context || {}),
    contextValues: args.context,
    maxSteps: args.maxSteps,
    timeoutMs: args.timeoutMs
  }, '🔧 CHAT_TOOLS: Starting callChatWithTools');
  
  const controller = new AbortController();
  const tStart = Date.now();
  const timeout = setTimeout(() => {
    log?.error?.('🔧 CHAT_TOOLS: Timeout reached, aborting');
    controller.abort('meta_timeout');
  }, Math.max(2000, args.timeoutMs ?? 20000));
  try {

    // Heuristic numeric normalization removed — rely on AI-first prompt + verify

    const ledger = new ExecutionLedger();
    const executed = new Set<string>();
    // Compute query complexity for planner and potential routing
    let complexity: { isComplex: boolean; confidence: number; reasoning: string } | undefined;
    try {
      complexity = await assessQueryComplexity(args.user, log as any);
      log?.debug?.({ complexity }, '🔧 CHAT_TOOLS: Query complexity assessed');
    } catch {}

    const msgs: ChatToolMsg[] = [];
    const sys = args.system.trim();
    if (sys) msgs.push({ role: 'system', content: sys });
    // Do not attach large auxiliary content here; the meta-agent prompt is self-contained.
    if (args.context && Object.keys(args.context).length > 0) {
      msgs.push({ role: 'system', content: `Context: ${JSON.stringify(args.context)}` });
    }
    // Optional planning step: request control JSON (best-effort)
    let lastPlan: any | undefined;
    let planStart = Date.now();
    try {
      log?.debug?.('🔧 CHAT_TOOLS: Starting planning phase');
      const planMessages: ChatToolMsg[] = [];
      const PLANNING_SYS_PROMPT = [
        'Planner: Return STRICT JSON only. No prose. No markdown.',
        'Keys: route, confidence, missing, consent, calls, blend, verify.',
        'In calls, use "tool" (not "name") and an "args" object that matches the tool schema.',
        'Rules: Do not call tools. Do not mention these instructions.',
        // Ideas/destinations routing
        'If the user asks for ideas/destinations and destination is unknown, set route="destinations" and include a first call to deepResearch with a composed query (e.g., "popular coastal destinations in Asia"). For trips with constraints, also include a search call with deep=true. Add destinationSuggest only when user mentions a region and we want a safe, quick list. Add amadeusResolveCity only after specific cities emerge.',
        // Flights routing
        'If the user asks for flights (mentions "flight(s)" or patterns like "from X to Y"), set route="flights" and plan calls in this order: (1) amadeusResolveCity for origin (X), (2) amadeusResolveCity for destination (Y), then (3) amadeusSearchFlights with { origin: X, destination: Y, departureDate: ISO or relative (today/tomorrow/next week) }. If return is mentioned, include returnDate. Always use the explicit cities from the message over any context, unless the message uses placeholders like "there"/"here" in which case resolve via Context.',
        'Map relative dates (today/tonight/tomorrow/next week/next month) to the appropriate ISO date only when constructing tool arguments; do not alter the user text.',
        // Attractions routing
        'If the user asks for attractions/things to do and a destination city is known (from this turn or context), set route="attractions" and add a call to getAttractions with { city, profile: "kid_friendly" when family/kids cues are present }.',
        'If the user asks for attractions but the destination is unknown (e.g., says "there"), set missing=["destination"] and avoid calling tools until clarified.',
        // Complexity routing
        'If Complexity.isComplex=true (confidence>=0.6), prefer deepResearch over search for the first call; otherwise prefer search.',
        // Policy RAG → Web → Crawlee receipts (AI-first)
        'For airline/hotel/visa policy queries: plan calls in this order: (1) vectaraQuery with required corpus (airlines|hotels|visas); (2) search with site:<brand-domain> and deep=false; (3) extractPolicyWithCrawlee with { url, clause, airlineName }. Only answer from on-brand receipts.',
        'Visa alignment: Ensure receipts explicitly match the nationality→destination pair in the user question. If vectaraQuery surfaces off-topic results, ignore them and prefer official sovereign domains (gov.cn, embassy, diplo.de) via search.',
        'Visa durations: Never propose a number unless it appears in receipts for this turn. If unclear or conflicting, either ask one confirmation or link without a number.',
        'Be concise; omit empty fields.',
      ].join(' ');
      try {
        const { createHash } = await import('node:crypto');
        const planHash = createHash('sha256').update(PLANNING_SYS_PROMPT).digest('hex').slice(0, 12);
        log?.debug?.({ planPromptHash: planHash, planPromptLength: PLANNING_SYS_PROMPT.length }, '🔧 CHAT_TOOLS: Planning prompt version');
      } catch {}
      planMessages.push({ role: 'system', content: PLANNING_SYS_PROMPT });
      if (complexity) planMessages.push({ role: 'system', content: `Complexity: ${JSON.stringify(complexity)}` });
      if (args.context && Object.keys(args.context).length > 0) {
        planMessages.push({ role: 'system', content: `Context: ${JSON.stringify(args.context)}` });
      }
      planMessages.push({
        role: 'user',
        content: `CONTROL_REQUEST: Return STRICT JSON control block only for this user request. Do NOT call tools. User: ${args.user}`,
      });

      log?.debug?.({ 
        planMessagesCount: planMessages.length,
        planTimeoutMs: Math.min(5000, Math.max(1500, (args.timeoutMs ?? 20000) - 5000))
      }, '🔧 CHAT_TOOLS: Calling LLM for planning');

      planStart = Date.now();
      const planRes = await chatWithToolsLLM({
        messages: planMessages,
        tools: [],
        timeoutMs: Math.min(5000, Math.max(1500, (args.timeoutMs ?? 20000) - 5000)),
        log,
      });

      if (planRes?.error) {
        log?.error?.({ error: planRes.error }, '🔧 CHAT_TOOLS: Planning LLM returned error');
      } else {
        log?.debug?.({ 
          planChoices: planRes.choices?.length || 0,
          planContent: planRes.choices?.[0]?.message?.content?.substring(0, 200)
        }, '🔧 CHAT_TOOLS: Planning LLM response received');
      }

      const planMsg = planRes.choices?.[0]?.message?.content;
      if (typeof planMsg === 'string' && planMsg.trim()) {
        let plan: any | undefined;
        try {
          plan = JSON.parse(planMsg.trim());
          log?.debug?.({ plan }, '🔧 CHAT_TOOLS: Planning JSON parsed successfully');
        } catch {
          const match = planMsg.match(/\{[\s\S]*\}/);
          if (match) {
            try { 
              plan = JSON.parse(match[0]); 
              log?.debug?.({ plan }, '🔧 CHAT_TOOLS: Planning JSON extracted from match');
            } catch (e) {
              log?.debug?.({ error: String(e), planMsg }, '🔧 CHAT_TOOLS: Failed to parse planning JSON from match');
            }
          } else {
            log?.debug?.({ planMsg }, '🔧 CHAT_TOOLS: No JSON found in planning response');
          }
        }
        if (plan && typeof plan === 'object') {
          lastPlan = plan;
          if (typeof plan.confidence === 'number' && typeof plan.route === 'string') {
            log?.debug?.({ 
              confidence: plan.confidence, 
              route: plan.route,
              intent: plan.intent,
              entities: plan.entities
            }, '🔧 CHAT_TOOLS: Setting route confidence and routing decision');
            setMetaRouteConfidence(plan.confidence, plan.route);
            noteMetaRoutingDecision(plan.route);
            try {
              // Record route stage metrics: success or clarification if missing slots
              const routeIntent = String(plan.route || plan.intent || 'unknown');
              const dur = Date.now() - planStart;
              if (Array.isArray(plan.missing) && plan.missing.length > 0) {
                observeStageClarify('route', routeIntent, dur);
              } else {
                observeStage('route', dur, true, routeIntent);
              }
            } catch {}
          }
          msgs.push({ role: 'assistant', content: JSON.stringify(plan) });
        } else {
          log?.debug?.({ planMsg }, '🔧 CHAT_TOOLS: Planning response not a valid object');
          try {
            const dur = Date.now() - planStart;
            observeStage('route', dur, false, 'unknown');
          } catch {}
        }
      } else {
        log?.debug?.('🔧 CHAT_TOOLS: No planning message content received');
        try {
          const dur = Date.now() - planStart;
          observeStage('route', dur, false, 'unknown');
        } catch {}
      }
    } catch (error) {
      log?.error?.({ error: String(error) }, '🔧 CHAT_TOOLS: Planning phase failed');
      try {
        const dur = Date.now() - planStart;
        observeStage('route', dur, false, 'unknown');
      } catch {}
    }

    // Add the actual user message for action
    msgs.push({ role: 'user', content: args.user });

    log?.debug?.({ 
      totalMessages: msgs.length,
      toolsAvailable: tools.length,
      toolNames: tools.map(t => t.name)
    }, '🔧 CHAT_TOOLS: Starting main execution loop');

    let activeToolNames = allowedToolsForRoute(lastPlan?.route);
    let toolSpecs = tools.filter(t => activeToolNames.includes(t.name)).map(t => t.spec);
    const facts: Array<{ key: string; value: string; source?: string }> = [];
    const decisions: string[] = [];
    const citations: string[] = [];

    const maxSteps = Math.max(1, Math.min(12, args.maxSteps ?? 6));
    log?.debug?.({ maxSteps }, '🔧 CHAT_TOOLS: Starting tool execution loop');
    
    for (let step = 0; step < maxSteps; step++) {
      log?.debug?.({ 
        step, 
        maxSteps,
        messagesCount: msgs.length,
        factsCount: facts.length,
        decisionsCount: decisions.length
      }, '🔧 CHAT_TOOLS: Loop iteration start');
      
      // Allocate dynamic per-step time budget
      const elapsed = Date.now() - tStart;
      const remaining = Math.max(0, (args.timeoutMs ?? 20000) - elapsed);
      const stepTimeoutMs = Math.max(1500, Math.min(15000, remaining - 500));

      // Recompute active tools if route was determined in planning
      activeToolNames = allowedToolsForRoute(lastPlan?.route);
      toolSpecs = tools.filter(t => activeToolNames.includes(t.name)).map(t => t.spec);
      const res = await chatWithToolsLLM({ 
        messages: msgs, 
        tools: toolSpecs, 
        timeoutMs: Math.max(3000, stepTimeoutMs), 
        log, 
        signal: controller.signal 
      });

      log?.debug?.({ 
        step,
        choicesCount: res.choices?.length || 0,
        hasMessage: !!res.choices?.[0]?.message
      }, '🔧 CHAT_TOOLS: LLM response received');

      const choice = res.choices?.[0];
      const message = choice?.message as any;
      if (!message) {
        log?.debug?.({ step }, '🔧 CHAT_TOOLS: No message in response');
        // Best-effort: execute planned calls if available
        // Do not replay planned calls on missing message; return to fallback
        // If still here, break and let outer fallback handle minimal response
        break;
      }

      const tcs = message.tool_calls as Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined;
      if (tcs && tcs.length > 0) {
        log?.debug?.({ 
          step,
          toolCallsCount: tcs.length,
          toolCallNames: tcs.map(tc => tc.function?.name)
        }, '🔧 CHAT_TOOLS: Processing tool calls');
        
        // Execute tool calls sequentially; parallelization can be added later
        for (const tc of tcs) {
          const toolName = tc.function?.name;
          const tool = tools.find(t => t.name === toolName);
          
          log?.debug?.({ 
            step,
            toolName,
            toolFound: !!tool,
            arguments: tc.function.arguments
          }, '🔧 CHAT_TOOLS: Executing tool call');
          
          if (!tool) {
            log?.error?.({ toolName, availableTools: tools.map(t => t.name) }, '🔧 CHAT_TOOLS: Unknown tool requested');
            msgs.push({ role: 'tool', name: toolName || 'unknown', tool_call_id: tc.id, content: JSON.stringify({ ok: false, reason: 'unknown_tool' }) });
            continue;
          }
          let parsed: unknown;
          try { 
            parsed = JSON.parse(tc.function.arguments || '{}'); 
            log?.debug?.({ toolName, parsed }, '🔧 CHAT_TOOLS: Tool arguments parsed');
          } catch (e) { 
            parsed = {}; 
            incMetaParseFailure();
            log?.error?.({ toolName, arguments: tc.function.arguments, error: String(e) }, '🔧 CHAT_TOOLS: Failed to parse tool arguments');
          }
          // Route-based gating: if tool is not in active list, skip
          if (!activeToolNames.includes(tool.name)) {
            incMetaToolGatedSkip(tool.name, String(lastPlan?.route || ''));
            log?.debug?.({ toolName: tool.name, route: lastPlan?.route }, '🔧 CHAT_TOOLS: Tool gated by route, skipping');
            msgs.push({ role: 'tool', name: tool.name, tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: 'gated_by_route' }) });
            continue;
          }
          // Ledger dedupe/skip
          const sig = `${tool.name}:${stableHash(parsed)}`;
          if (executed.has(sig)) {
            incMetaToolLedgerHit(tool.name);
            log?.debug?.({ toolName: tool.name }, '🔧 CHAT_TOOLS: Duplicate tool call in same turn, skipping');
            msgs.push({ role: 'tool', name: tool.name, tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: 'duplicate_in_turn' }) });
            continue;
          }
          if (ledger.shouldSkip(tool.name, parsed)) {
            incMetaToolSkippedByLedger(tool.name);
            log?.debug?.({ toolName: tool.name }, '🔧 CHAT_TOOLS: Skipping tool due to prior failure in ledger');
            msgs.push({ role: 'tool', name: tool.name, tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: 'skipped_by_ledger' }) });
            continue;
          }
          const inTok = Math.ceil(JSON.stringify(msgs).length / 4);
          const t0 = Date.now();
          incMetaToolCall(tool.name);
          
          try {
            const out = await tool.call(parsed, { signal: controller.signal });
            const latency = Date.now() - t0;
            observeMetaToolLatency(tool.name, latency);
            addMetaTokens(inTok, 0);
            executed.add(sig);
            ledger.finish(tool.name, parsed, { ok: true });
            try {
              const routeIntent = String(lastPlan?.route || lastPlan?.intent || 'unknown');
              observeStage('gather', latency, Boolean((out as any)?.ok ?? true), routeIntent);
            } catch {}
            
            log?.debug?.({ 
              toolName, 
              latency,
              outputType: typeof out,
              outputKeys: out && typeof out === 'object' ? Object.keys(out) : undefined
            }, '🔧 CHAT_TOOLS: Tool execution completed');
            
            try {
              // Best-effort receipts from tool outputs
              const o: any = out;
              if (o && typeof o === 'object') {
                if (o.ok && o.summary) {
                  facts.push({ key: tool.name, value: String(o.summary), source: o.source });
                  if (o.source) citations.push(String(o.source));
                  if (Array.isArray(o.citations)) {
                    for (const c of o.citations) {
                      if (typeof c === 'string') citations.push(c);
                    }
                  }
                  // Enrich facts for packingSuggest so blending & verification can ground in curated items
                  if (tool.name === 'packingSuggest') {
                    try {
                      const items = o.items as { base: string[]; special: Record<string, string[]> };
                      const band = o.band as string | undefined;
                      if (band) facts.push({ key: 'packingBand', value: String(band), source: o.source });
                      if (items && Array.isArray(items.base)) {
                        const basePreview = items.base.slice(0, 10);
                        facts.push({ key: 'packingItemsBase', value: JSON.stringify(basePreview), source: 'curated' });
                      }
                      if (items && items.special && typeof items.special === 'object') {
                        const specialPreview: Record<string, string[]> = {};
                        for (const [k, arr] of Object.entries(items.special)) {
                          if (Array.isArray(arr) && arr.length > 0) specialPreview[k] = arr.slice(0, 8);
                        }
                        if (Object.keys(specialPreview).length > 0) {
                          facts.push({ key: 'packingItemsSpecial', value: JSON.stringify(specialPreview), source: 'curated' });
                        }
                      }
                    } catch {}
                  }
                  log?.debug?.({ 
                    toolName, 
                    factAdded: true, 
                    summary: String(o.summary).substring(0, 100),
                    source: o.source
                  }, '🔧 CHAT_TOOLS: Fact extracted from tool output');
                } else {
                  log?.debug?.({ 
                    toolName, 
                    ok: o.ok, 
                    hasSummary: !!o.summary,
                    outputSample: JSON.stringify(o).substring(0, 200)
                  }, '🔧 CHAT_TOOLS: No fact extracted from tool output');
                }
              }
            } catch (e) {
              log?.error?.({ toolName, error: String(e) }, '🔧 CHAT_TOOLS: Error extracting facts from tool output');
            }
            msgs.push({ role: 'tool', name: tool.name, tool_call_id: tc.id, content: JSON.stringify(out ?? {}) });
          } catch (error) {
            const latency = Date.now() - t0;
            observeMetaToolLatency(tool.name, latency);
            log?.error?.({ 
              toolName, 
              latency,
              error: String(error),
              isAbortError: error instanceof Error && error.name === 'AbortError'
            }, '🔧 CHAT_TOOLS: Tool execution failed');
            try {
              const routeIntent = String(lastPlan?.route || lastPlan?.intent || 'unknown');
              observeStage('gather', latency, false, routeIntent);
            } catch {}
            try {
              const s = String(error).toLowerCase();
              let cat = 'other';
              if (s.includes('abort') || s.includes('timeout')) cat = 'timeout';
              else if (/\b429\b/.test(s)) cat = 'http_429';
              else if (/\b403\b/.test(s)) cat = 'http_403';
              else if (/\b5\d\d\b/.test(s)) cat = 'http_5xx';
              else if (/\b4\d\d\b/.test(s)) cat = 'http_4xx';
              incMetaToolError(tool.name, cat);
            } catch {}
            executed.add(sig);
            // Rough HTTP code extraction if present in error string
            const m = String(error).match(/\b(403|429)\b/);
            const http = m ? Number(m[1]) : undefined;
            ledger.finish(tool.name, parsed, { ok: false, http, err: String(error) });
            msgs.push({ role: 'tool', name: tool.name, tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: String(error) }) });
          }
        }
        // Continue loop to let the model read tool results
        log?.debug?.({ step }, '🔧 CHAT_TOOLS: Continuing loop after tool calls');
        continue;
      }

      // No tool calls; return final content
      const content = typeof message.content === 'string' ? message.content : '';
      addMetaTokens(0, Math.ceil((content || '').length / 4));
      
      log?.debug?.({ 
        step,
        finalContent: content.substring(0, 200),
        factsCount: facts.length,
        decisionsCount: decisions.length,
        citationsCount: citations.length
      }, '🔧 CHAT_TOOLS: Returning final result');
      // Ledger summary
      try {
        log?.debug?.({ executedCount: executed.size, allowedTools: activeToolNames }, '🔧 CHAT_TOOLS: Ledger summary');
      } catch {}
      const dedupCites = Array.from(new Set(citations)).slice(0, 8);
      const finalContent = content || '';
      try {
        // High-level alignment log only; no regex parsing or normalization
        log?.debug?.({ route: (lastPlan?.route || lastPlan?.intent || ''), factsCount: facts.length, citations: dedupCites }, 'blend_summary');
      } catch {}
      return { result: finalContent, facts, decisions, citations: dedupCites };
    }

    // Fallback minimal behavior (offline/test environments)
    log?.debug?.('🔧 CHAT_TOOLS: Reached fallback behavior - checking for weather intent');
    const lower = (args.user || '').toLowerCase();
    if (/weather|temperature|rain|forecast/.test(lower)) {
      log?.debug?.('🔧 CHAT_TOOLS: Weather intent detected in fallback');
      try {
        const city = (args.context?.city as string) || (args.user.match(/in\s+([\p{L} ]+)/iu)?.[1] || '').trim();
        log?.debug?.({ city, contextCity: args.context?.city }, '🔧 CHAT_TOOLS: Extracted city for weather fallback');
        if (city && tools.length > 0) {
          const out: any = await tools[0]!.call({ city }, {});
          log?.debug?.({ 
            weatherResult: out,
            hasSource: !!out?.source,
            hasSummary: !!out?.summary
          }, '🔧 CHAT_TOOLS: Weather tool result in fallback');
          const reply = out?.ok && out.summary ? `Weather — ${out.summary}${out.source ? `\n\nSource: ${out.source}` : ''}` : `I found no reliable weather data for ${city}.`;
          if (out?.source) citations.push(out.source);
          const dedupCites = Array.from(new Set(citations)).slice(0, 8);
          return { result: reply, facts, decisions, citations: dedupCites };
        } else {
          log?.debug?.('🔧 CHAT_TOOLS: No city found for weather fallback');
        }
      } catch (e) {
        log?.error?.({ error: String(e) }, '🔧 CHAT_TOOLS: Weather fallback failed');
      }
    }
    
    log?.debug?.({ 
      factsCount: facts.length,
      decisionsCount: decisions.length,
      citationsCount: citations.length
    }, '🔧 CHAT_TOOLS: Returning default fallback response');
    try { log?.debug?.({ executedCount: executed.size }, '🔧 CHAT_TOOLS: Fallback return with ledger summary'); } catch {}
    const dedupCites = Array.from(new Set(citations)).slice(0, 8);
    return { result: 'I need a city or destination to help.', facts, decisions, citations: dedupCites };
  } finally {
    clearTimeout(timeout);
  }
}
