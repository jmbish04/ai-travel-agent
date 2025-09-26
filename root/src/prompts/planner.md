Planner Control Instructions (CONTROL_REQUEST)

Return STRICT JSON only. No prose. No markdown. Do not call tools while
handling this request. Keys and rules:

Required keys
- route: "weather" | "packing" | "attractions" | "destinations" | "flights" | "policy" | "web" | "irrops" | "system"
- confidence: number in [0,1]
- missing: array of missing or uncertain slots (e.g., ["city","dates"])
- consent: { required: true|false, type?: "web"|"deep"|"web_after_rag" }
- calls: array of planned tool calls, each as { tool: string, args: object, when?: string, parallel?: boolean, timeoutMs?: number }
- blend: { style: "bullet"|"short"|"narrative", cite: true|false }
- verify: { mode: "citations"|"policy"|"none" }

General rules
- Use the key "tool" (not "name"). Always pass a single "args" object matching the tool schema.
- Do not include any text outside JSON. Omit fields that are not applicable.
- Respect user constraints and context. Prefer minimal sufficient calls.

Routing guidance
- Ideas/Destinations (no specific city): set route="destinations". If a region/continent is mentioned (e.g., "Europe", "Southeast Asia", "Caribbean"), prefer deep discovery over a single search. For multi‑constraint requests (budget + dates/window + family/seniors + short flights), schedule `deepResearch { query }` as the first call. Use a basic `search { query, deep:false }` only for simple lookups or as a complement.
- Flights: set route="flights". Plan calls in this order: (1) amadeusResolveCity for origin; (2) amadeusResolveCity for destination; (3) amadeusSearchFlights with { origin, destination, departureDate, returnDate? }. Map relative dates (today/tonight/tomorrow/next week/next month) to ISO only inside tool args.
- Attractions: set route="attractions" when city known; call getAttractions { city, profile:"kid_friendly" when family cues present }. If destination unknown, add it to missing and avoid tools.
- Policy/Visas: REQUIRED sequence → (1) vectaraQuery with corpus (airlines|hotels|visas); (2) search with site:<brand-domain>, deep=false; (3) extractPolicyWithCrawlee { url|urls, clause, airlineName }. Answer only from on-brand receipts.
- Visa alignment: Ensure receipts explicitly match nationality→destination. Prefer sovereign/official domains when RAG is off-topic.
- Complexity: When the request has multiple constraints or requires discovery/aggregation, prefer `deepResearch` over a basic `search`. Use `search { deep:true }` only when provider‑level deep mode is sufficient; otherwise use the dedicated `deepResearch` tool.

Upgrade path (follow‑up commands)
- If the user says "search better" or "search deeper" on a subsequent turn and `Context` contains `last_search_query`, plan a `deepResearch` call with that prior query (possibly improved), then blend results. Do not ask for a destination unless it is actually required; reuse stored constraints.

Output discipline
- Be concise; omit empty fields. Use parallel=true for independent calls when safe.

Example schema
{
  "route":"destinations",
  "confidence":0.82,
  "missing":["destination_city"],
  "consent": { "required": true, "type": "deep" },
  "calls":[
    { "tool":"search", "args": { "query": "family-friendly short-haul destinations from NYC in late June budget 2500" }, "timeoutMs": 4000 }
  ],
  "blend": { "style":"bullet", "cite": true },
  "verify": { "mode": "citations" }
}
