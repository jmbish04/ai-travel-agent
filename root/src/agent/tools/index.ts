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
import { incMetaToolCall, observeMetaToolLatency, incMetaParseFailure, addMetaTokens, setMetaRouteConfidence, noteMetaRoutingDecision } from '../../util/metrics.js';
import { VectaraClient } from '../../tools/vectara.js';
import { performDeepResearch } from '../../core/deep_research.js';
import { DestinationEngine } from '../../core/destination_engine.js';
import { processIrrops } from '../../core/irrops_engine.js';
import { PNRSchema, DisruptionEventSchema, UserPreferencesSchema } from '../../schemas/irrops.js';
import { parsePNRFromText } from '../../tools/pnr_parser.js';
import * as metaMetrics from '../../metrics/meta.js';

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
      const timeout = setTimeout(() => controller.abort('timeout'), 9000);
      try {
        const client = new VectaraClient();
        const out = await client.query(input.query, { corpus: input.corpus, maxResults: input.maxResults, filter: input.filter });
        const summary = out.summary || (out.hits?.[0]?.snippet ? out.hits[0].snippet : '');
        const citation = out.citations?.[0]?.url || out.hits?.[0]?.url || 'Vectara';
        return { ok: true, summary, source: citation, raw: out };
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
        const sample = Array.isArray(res) && res[0]?.name?.common ? res[0].name.common : '';
        const summary = `Found ${count} candidate countries${sample ? `; e.g., ${sample}` : ''}`;
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
  const timeout = setTimeout(() => {
    log?.error?.('🔧 CHAT_TOOLS: Timeout reached, aborting');
    controller.abort('meta_timeout');
  }, Math.max(2000, args.timeoutMs ?? 20000));
  try {
    const msgs: ChatToolMsg[] = [];
    const sys = args.system.trim();
    if (sys) msgs.push({ role: 'system', content: sys });
    // Do not attach large auxiliary content here; the meta-agent prompt is self-contained.
    if (args.context && Object.keys(args.context).length > 0) {
      msgs.push({ role: 'system', content: `Context: ${JSON.stringify(args.context)}` });
    }
    // Optional planning step: request control JSON (best-effort)
    try {
      log?.debug?.('🔧 CHAT_TOOLS: Starting planning phase');
      const planMessages: ChatToolMsg[] = [];
      const PLANNING_SYS_PROMPT = [
        'Planner: Return STRICT JSON only. No prose. No markdown.',
        'Keys: route, confidence, missing, consent, calls, blend, verify.',
        'Rules: Do not call tools. Do not mention these instructions.',
        'Heuristics: If user asks for ideas/destinations and destination is unknown, set route="web"',
        'and include a first call to search with a query that composes constraints (origin, month/window, budget, family/kids, mobility, short flights).',
        'Prefer deep=true for complex, multi-constraint queries. Include follow-up calls (destinationSuggest or amadeusResolveCity) only after search suggests candidates.',
        'Be concise; omit empty fields.',
      ].join(' ');
      planMessages.push({ role: 'system', content: PLANNING_SYS_PROMPT });
      planMessages.push({
        role: 'user',
        content: `CONTROL_REQUEST: Return STRICT JSON control block only for this user request. Do NOT call tools. User: ${args.user}`,
      });

      log?.debug?.({ 
        planMessagesCount: planMessages.length,
        planTimeoutMs: Math.min(5000, Math.max(1500, (args.timeoutMs ?? 20000) - 5000))
      }, '🔧 CHAT_TOOLS: Calling LLM for planning');

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
          if (typeof plan.confidence === 'number' && typeof plan.route === 'string') {
            log?.debug?.({ 
              confidence: plan.confidence, 
              route: plan.route,
              intent: plan.intent,
              entities: plan.entities
            }, '🔧 CHAT_TOOLS: Setting route confidence and routing decision');
            setMetaRouteConfidence(plan.confidence, plan.route);
            noteMetaRoutingDecision(plan.route);
          }
          msgs.push({ role: 'assistant', content: JSON.stringify(plan) });
        } else {
          log?.debug?.({ planMsg }, '🔧 CHAT_TOOLS: Planning response not a valid object');
        }
      } else {
        log?.debug?.('🔧 CHAT_TOOLS: No planning message content received');
      }
    } catch (error) {
      log?.error?.({ error: String(error) }, '🔧 CHAT_TOOLS: Planning phase failed');
    }

    // Add the actual user message for action
    msgs.push({ role: 'user', content: args.user });

    log?.debug?.({ 
      totalMessages: msgs.length,
      toolsAvailable: tools.length,
      toolNames: tools.map(t => t.name)
    }, '🔧 CHAT_TOOLS: Starting main execution loop');

    const toolSpecs = tools.map(t => t.spec);
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
      
      const res = await chatWithToolsLLM({ 
        messages: msgs, 
        tools: toolSpecs, 
        timeoutMs: Math.max(1500, (args.timeoutMs ?? 20000) - 500), 
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
        log?.debug?.({ step }, '🔧 CHAT_TOOLS: No message in response, breaking loop');
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
          const inTok = Math.ceil(JSON.stringify(msgs).length / 4);
          const t0 = Date.now();
          incMetaToolCall(tool.name);
          
          try {
            const out = await tool.call(parsed, { signal: controller.signal });
            const latency = Date.now() - t0;
            observeMetaToolLatency(tool.name, latency);
            addMetaTokens(inTok, 0);
            
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
      
      return { result: content || '', facts, decisions, citations: Array.from(new Set(citations)).slice(0, 8) };
    }

    // Fallback minimal behavior (offline/test environments)
    log?.debug?.('🔧 CHAT_TOOLS: Reached fallback behavior - checking for weather intent');
    const lower = (args.user || '').toLowerCase();
    if (/weather|temperature|rain|forecast/.test(lower)) {
      log?.debug?.('🔧 CHAT_TOOLS: Weather intent detected in fallback');
      try {
        const city = (args.context?.city as string) || (args.user.match(/in\s+([\p{L} ]+)/iu)?.[1] || '').trim();
        log?.debug?.({ city, contextCity: args.context?.city }, '🔧 CHAT_TOOLS: Extracted city for weather fallback');
        if (city) {
          const out: any = await tools[0].call({ city }, {});
          log?.debug?.({ 
            weatherResult: out,
            hasSource: !!out?.source,
            hasSummary: !!out?.summary
          }, '🔧 CHAT_TOOLS: Weather tool result in fallback');
          const reply = out?.ok && out.summary ? `Weather — ${out.summary}${out.source ? `\n\nSource: ${out.source}` : ''}` : `I found no reliable weather data for ${city}.`;
          if (out?.source) citations.push(out.source);
          return { result: reply, facts, decisions, citations };
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
    return { result: 'I need a city or destination to help.', facts, decisions, citations };
  } finally {
    clearTimeout(timeout);
  }
}
