```mermaid
flowchart TD
  %% Big LLM First — Single Meta‑Agent Orchestration
  A["User Message"] --> B["/chat (API)"]
  B --> C["handleChat()<br/>root/src/core/blend.ts"]
  C --> D["runMetaAgentTurn()<br/>root/src/agent/meta_agent.ts"]

  subgraph META["Meta Agent (Analyze-Plan-Act-Blend)"]
    D --> M0["Load meta_agent.md<br/>(getPrompt)<br/>log prompt hash/version"]
    M0 --> M1["Analyze & Plan (LLM)<br/>CONTROL JSON: route, missing, consent, calls"]
    M1 --> M2["Act (LLM tools loop)<br/>chatWithToolsLLM()"]

    subgraph TOOLS["Tools Registry<br/>root/src/agent/tools/index.ts"]
      M2 --> T1["weather, getCountry, getAttractions"]
      M2 --> T2["searchTravelInfo (Brave/Tavily)"]
      M2 --> T3["vectaraQuery (RAG locator)"]
      M2 --> T4["deepResearch (Crawlee receipts)"]
      M2 --> T5["Amadeus: resolve city/airports/flights"]
      T1 --> M2
      T2 --> M2
      T3 --> M2
      T4 --> M2
      T5 --> M2
    end

    M2 --> M3["Blend (LLM) → result"]
  end

  %% Receipts + Metrics
  M3 --> R0["setLastReceipts(facts, decisions, reply)<br/>slot_memory"]
  R0 --> R1["incReceiptsWrittenTotal, add citation metrics<br/>util/metrics"]
  R1 --> E0["Return from meta turn"]

  %% Optional Auto‑Verify
  E0 --> V0{"AUTO_VERIFY_REPLIES?"}
  V0 -->|Yes| V1["verifyAnswer()<br/>root/src/core/verify.ts<br/>(getPrompt 'verify')"]
  V1 --> V2{"verdict = fail and revised?"}
  V2 -->|Yes| V3["Use revised answer"]
  V2 -->|No| V4["Keep meta reply"]
  V1 --> V5["store verification artifact\nslot_memory.setLastVerification"]
  V0 -->|No| V4

  %% Final
  V3 --> OUT["ChatOutput to user"]
  V4 --> OUT

  %% Observability & Resilience (surrounding external calls)
  subgraph OBS["Resilience & Metrics"]
    RL["Bottleneck RateLimiter (tools)"]
    CB["Opossum Circuit Breakers"]
    M["Metrics JSON/Prom: pipeline stages, verify pass, e2e latency"]
  end
```

Implementation Map (Big‑LLM First)
- Entry/API: `root/src/api/routes.ts`, `root/src/schemas/chat.ts`
- Orchestrator: `root/src/core/blend.ts` (handleChat)
- Meta‑agent runner: `root/src/agent/meta_agent.ts`
- Tools registry + planning prompt (CONTROL JSON): `root/src/agent/tools/index.ts`
- LLM client + tools: `root/src/core/llm.ts` (chatWithToolsLLM, callLLM)
- Receipts & verification: `root/src/core/receipts.ts`, `root/src/core/verify.ts`, `root/src/core/slot_memory.ts`
- External adapters: `root/src/tools/*.ts`, `root/src/core/deep_research.ts`, `root/src/tools/crawlee_research.ts`, `root/src/tools/vectara.ts`, `root/src/tools/amadeus_*`
- Resilience & metrics: `root/src/util/metrics.ts`, `root/src/util/circuit.ts`, `root/src/core/circuit-breaker.ts`, `root/src/util/limiter.ts`, `root/src/util/metrics-server.ts`, `root/src/api/server.ts`
