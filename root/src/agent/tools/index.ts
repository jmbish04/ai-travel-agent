import { z } from 'zod';
import Bottleneck from 'bottleneck';
import { retry, handleAll, ExponentialBackoff } from 'cockatiel';
import type pino from 'pino';
import { getWeather } from '../../tools/weather.js';
import { getCountryFacts } from '../../tools/country.js';
import { getAttractions } from '../../tools/attractions.js';
import { chatWithToolsLLM } from '../../core/llm.js';
import { resolveCity as amadeusResolveCityFn, airportsForCity as amadeusAirportsForCityFn } from '../../tools/amadeus_locations.js';
import { searchFlights as amadeusSearchFlights } from '../../tools/amadeus_flights.js';
import { incMetaToolCall, observeMetaToolLatency, incMetaParseFailure, addMetaTokens, setMetaRouteConfidence, noteMetaRoutingDecision } from '../../util/metrics.js';
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('meta_timeout'), Math.max(2000, args.timeoutMs ?? 20000));
  try {
    const msgs: ChatToolMsg[] = [];
    const sys = args.system.trim();
    if (sys) msgs.push({ role: 'system', content: sys });
    for (const a of (args.attachments || [])) {
      if (a.content?.trim()) msgs.push({ role: 'system', content: `Attachment: ${a.name}\n\n${a.content}` });
    }
    if (args.context && Object.keys(args.context).length > 0) {
      msgs.push({ role: 'system', content: `Context: ${JSON.stringify(args.context)}` });
    }
    // Optional planning step: request control JSON (no tools)
    try {
      const planMsgs: ChatToolMsg[] = [];
      if (sys) planMsgs.push({ role: 'system', content: sys });
      for (const a of (args.attachments || [])) {
        if (a.content?.trim()) planMsgs.push({ role: 'system', content: `Attachment: ${a.name}\n\n${a.content}` });
      }
      if (args.context && Object.keys(args.context).length > 0) {
        planMsgs.push({ role: 'system', content: `Context: ${JSON.stringify(args.context)}` });
      }
      planMsgs.push({ role: 'user', content: `CONTROL_REQUEST: Return STRICT JSON control block only for this user request. No tool calls. User: ${args.user}` });
      const planRes = await chatWithToolsLLM({ messages: planMsgs, tools: tools.map(t => t.spec), tool_choice: 'none', timeoutMs: Math.max(1200, (args.timeoutMs ?? 20000) - 1000), log, signal: controller.signal });
      const planMsg = planRes.choices?.[0]?.message?.content;
      if (typeof planMsg === 'string' && planMsg.trim()) {
        let plan: any | undefined;
        try { plan = JSON.parse(planMsg.trim()); } catch { try { plan = JSON.parse((planMsg.match(/\{[\s\S]*\}/)?.[0] || '{}')); } catch {} }
        if (plan && typeof plan === 'object') {
          if (typeof plan.confidence === 'number' && typeof plan.route === 'string') {
            setMetaRouteConfidence(plan.confidence, plan.route);
            noteMetaRoutingDecision(plan.route);
          }
          // Keep the plan visible to the model for subsequent actions
          msgs.push({ role: 'assistant', content: JSON.stringify(plan) });
        }
      }
    } catch {
      // planning is best-effort; proceed silently on failure
    }

    // Add the actual user message for action
    msgs.push({ role: 'user', content: args.user });

    const toolSpecs = tools.map(t => t.spec);
    const facts: Array<{ key: string; value: string; source?: string }> = [];
    const decisions: string[] = [];
    const citations: string[] = [];

    const maxSteps = Math.max(1, Math.min(12, args.maxSteps ?? 6));
    for (let step = 0; step < maxSteps; step++) {
      const res = await chatWithToolsLLM({ messages: msgs, tools: toolSpecs, timeoutMs: Math.max(1500, (args.timeoutMs ?? 20000) - 500), log, signal: controller.signal });

      const choice = res.choices?.[0];
      const message = choice?.message as any;
      if (!message) break;

      const tcs = message.tool_calls as Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined;
      if (tcs && tcs.length > 0) {
        // Execute tool calls sequentially; parallelization can be added later
        for (const tc of tcs) {
          const toolName = tc.function?.name;
          const tool = tools.find(t => t.name === toolName);
          if (!tool) {
            msgs.push({ role: 'tool', name: toolName || 'unknown', tool_call_id: tc.id, content: JSON.stringify({ ok: false, reason: 'unknown_tool' }) });
            continue;
          }
          let parsed: unknown;
          try { parsed = JSON.parse(tc.function.arguments || '{}'); } catch { parsed = {}; incMetaParseFailure(); }
          const inTok = Math.ceil(JSON.stringify(msgs).length / 4);
          const t0 = Date.now();
          incMetaToolCall(tool.name);
          const out = await tool.call(parsed, { signal: controller.signal });
          observeMetaToolLatency(tool.name, Date.now() - t0);
          addMetaTokens(inTok, 0);
          try {
            // Best-effort receipts from tool outputs
            const o: any = out;
            if (o && typeof o === 'object') {
              if (o.ok && o.summary) {
                facts.push({ key: tool.name, value: String(o.summary), source: o.source });
                if (o.source) citations.push(String(o.source));
              }
            }
          } catch {}
          msgs.push({ role: 'tool', name: tool.name, tool_call_id: tc.id, content: JSON.stringify(out ?? {}) });
        }
        // Continue loop to let the model read tool results
        continue;
      }

      // No tool calls; return final content
      const content = typeof message.content === 'string' ? message.content : '';
      addMetaTokens(0, Math.ceil((content || '').length / 4));
      return { result: content || '', facts, decisions, citations: Array.from(new Set(citations)).slice(0, 8) };
    }

    // Fallback minimal behavior (offline/test environments)
    const lower = (args.user || '').toLowerCase();
    if (/weather|temperature|rain|forecast/.test(lower)) {
      try {
        const city = (args.context?.city as string) || (args.user.match(/in\s+([\p{L} ]+)/iu)?.[1] || '').trim();
        if (city) {
          const out: any = await tools[0].call({ city }, {});
          const reply = out?.ok && out.summary ? `Weather — ${out.summary}${out.source ? `\n\nSource: ${out.source}` : ''}` : `I found no reliable weather data for ${city}.`;
          if (out?.source) citations.push(out.source);
          return { result: reply, facts, decisions, citations };
        }
      } catch {}
    }
    return { result: 'I need a city or destination to help.', facts, decisions, citations };
  } finally {
    clearTimeout(timeout);
  }
}
