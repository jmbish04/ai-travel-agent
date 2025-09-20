```mermaid
flowchart TD
    A["User Message"] --> B["runGraphTurn(message, threadId)"]

    %% G-E-R-A Pattern: Guard -> Extract -> Route -> Act
    %% GUARD STAGE: Fast micro-rules first
    B --> G1{"Consent flags set? (slot_memory.readConsentState)"}
    G1 -->|Yes| G2["checkYesNoShortcut()"]
    G2 --> G3{"Shortcut detected?"}
    G3 -->|Yes| G4["writeConsentState(clear) -> perform pending action or refuse"]
    G3 -->|No| Gx
    G1 -->|No| Gx
    
    %% Optional fast-path + search-upgrade check
    Gx["Pre-routing checks"] --> G9{"Weather fast-path today?"}
    G9 -->|Yes| G10["city_parser (LLM)"]
    G10 --> G11{"City found?"}
    G11 -->|Yes| G12["weatherNode() (Open-Meteo) -> return"]
    G11 -->|No| GU
    G9 -->|No| GU

    GU["Search upgrade? (search_upgrade_detector)"] -->|Yes| G13["performDeepResearchNode(previous_query) -> return"]
    GU -->|No| E

    %% EXTRACT STAGE: Single-pass cached extraction
    E["Extract Stage"] --> E1["buildTurnCache()"]
    E1 --> E2["routeIntent() - transformers-first + router_llm"]
    E2 --> E3{"Intent === flights?"}
    E3 -->|Yes| E4["flight_slot_extractor(); preserve relative dates"]
    E3 -->|No| E5["Lightweight extraction (city, etc.)"]
    E5 --> E6{"Need content classification?"}
    E6 -->|Yes| E7["classifyContent (transformers)"]
    E6 -->|No| R

    %% ROUTE STAGE: Decision table + slots
    R["Route Stage"] --> R3["normalizeSlots(); checkMissingSlots"]
    R3 --> S3{"Missing slots?"}
    S3 -->|Yes| S4["buildClarifyingQuestion() -> return"]
    S3 -->|No| S5["updateThreadSlots(); setLastIntent()"]

    %% ACT STAGE: Domain nodes
    S5 --> N{"Intent"}
    N -->|weather| Q["weatherNode() -> Open-Meteo"]
    N -->|destinations| RD["destinationsNode() with web fallback"]
    N -->|packing| S["packingNode() -> blendWithFacts"]
    N -->|attractions| T["attractionsNode() -> OpenTripMap"]
    N -->|policy| P["policyNode() -> PolicyAgent"]
    N -->|flights| F["flightsNode() / IRROPS paths"]
    N -->|web_search| U["webSearchNode()"]
    N -->|system| SYS["systemNode()"]
    N -->|unknown| V["unknownNode() -> blend"]

    %% PolicyAgent internals (RAG -> Browser receipts -> Summarize)
    P --> PA1["Query Vectara (semantic) with FCS filter"]
    PA1 --> PQ["policy_quality_assessor -> sufficient quality?"]
    PQ -->|Yes| PA3["Compose answer with citations"]
    PQ -->|No| PA4{"Visa question?"}
    PA4 -->|Yes| U
    PA4 -->|No| PA5["writeConsentState(web_after_rag) -> ask for web search"]
    %% Try browser-mode receipts (official policy pages)
    PA1 --> PA6["If low quality, try Playwright receipts (stealth)"]
    PA6 --> PA7{"Receipt confidence ≥ 0.6?"}
    PA7 -->|Yes| PA8["Summarize receipts (policy_summarizer) -> prefer receipts answer"]
    PA7 -->|No| PA5

    %% IRROPS (separate subgraph)
    F --> I1["IRROPS StateGraph: classify -> workflow -> completion"]
    I1 --> I2["processIrrops(): Amadeus alternatives -> constraint validate -> rank"]
    I2 --> I3["Compose top options + citations"]

    %% Web search
    U --> U1["searchTravelInfo() (Brave/Tavily) -> summarize"]

    %% Compose final answer + receipts
    PA3 --> Z
    PA8 --> Z
    Q --> Z
    RD --> Z
    S --> Z
    T --> Z
    U1 --> Z
    V --> Z
    I3 --> Z
    G12 --> Z
    G13 --> Z
    S4 --> Z
    SYS --> Z

    Z["Compose Final Answer"] --> Z1["Validate citations; setLastReceipts (facts/decisions)"]
    Z1 --> Z2{"/why or receipts flag?"}
    Z2 -->|Yes| Z3["verifyAnswer() -> adjust reply if fail"]
    Z2 -->|No| Z4["Return ChatOutput"]

    %% Resilience & Metrics (implicit around external calls)
    subgraph Resilience["Resilience & Metrics"]
      RLM["RateLimiter (server middleware)"]
      BRK["Opossum breaker per host (util/circuit)"]
      CBF["Custom breaker for Vectara"]
      MET["Metrics: externalAgg or Prom"]
    end
```

Implementation Map (code anchors)
- Orchestrator G‑E‑R‑A: `src/core/graph.ts`
- Router fast-paths and LLM router: `src/core/router.ts`
- Consent state read/write: `src/core/slot_memory.ts`
- PolicyAgent (RAG + browser receipts + summarizer): `src/core/policy_agent.ts`, `src/tools/policy_browser.ts`, `src/schemas/vectara.ts`
- IRROPS subgraph and engine: `src/agent/graphs/irrops.graph.ts`, `src/core/irrops_engine.ts`
- API `/chat` + receipts + self-check: `src/api/routes.ts`, `src/schemas/chat.ts`, `src/core/verify.ts`, `src/core/receipts.ts`
- Resilience & Metrics: `src/util/limiter.ts`, `src/util/circuit.ts`, `src/core/circuit-breaker.ts`, `src/util/metrics.ts`, `src/api/server.ts`
- Deep search upgrade detector: `src/core/search_upgrade.ts`
- Deep research consent (complexity assessor): `src/core/complexity.ts`
