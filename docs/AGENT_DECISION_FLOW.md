```mermaid
flowchart TD
  U["User message"] --> API["POST /chat\nroot/src/api/routes.ts"]
  API --> HANDLE["handleChat()\nroot/src/core/blend.ts"]
  HANDLE --> RUN["runMetaAgentTurn()\nroot/src/agent/meta_agent.ts"]

  subgraph MetaAgent["Meta Agent\nAnalyze → Plan → Act → Blend"]
    RUN --> LOAD["Load meta_agent.md\nlog prompt hash/version"]
    LOAD --> PLAN["Analyze + Plan (LLM)\nCONTROL JSON route/missing/calls"]
    PLAN --> ACT["chatWithToolsLLM()\nexecute tool plan"]
    ACT --> BLEND["Blend (LLM) grounded reply"]

    subgraph Tools["Tools Registry\nroot/src/agent/tools/index.ts"]
      ACT --> T1["weather / getCountry / getAttractions"]
      ACT --> T2["searchTravelInfo (Tavily/Brave)"]
      ACT --> T3["vectaraQuery (RAG locator)"]
      ACT --> T4["extractPolicyWithCrawlee / deepResearch"]
      ACT --> T5["Amadeus resolveCity / airports / flights"]
    end

    BLEND --> RECEIPTS["setLastReceipts()\nslot_memory.ts"]
  end

  RECEIPTS --> MET["observeStage / addMeta* metrics\nutil/metrics.ts"]
  MET --> AUTO{"AUTO_VERIFY_REPLIES=true?"}
  AUTO -->|Yes| VERIFY["verifyAnswer()\ncore/verify.ts\nctx: getContext + slots + intent"]
  VERIFY --> STORE["setLastVerification()\nslot_memory.ts"]
  VERIFY --> VERDICT{"verdict = fail & revised answer?"}
  VERDICT -->|Yes| REPLACE["Use revised answer\npushMessage(thread, revised)"]
  VERDICT -->|No| FINAL["Return meta reply"]
  STORE --> FINAL
  AUTO -->|No| FINAL
  REPLACE --> FINAL

  FINAL --> RESP["ChatOutput → caller"]
  RESP --> WHY["/why command\nreads receipts + stored verification"]
```

Implementation Map (Big‑LLM First)
- API entry: `root/src/api/routes.ts` (handles `/chat`, `/metrics`, `/why`).
- Orchestrator: `root/src/core/blend.ts` (stores user turns, auto-verify, metrics).
- Meta agent runner: `root/src/agent/meta_agent.ts` (loads `meta_agent.md`, calls `callChatWithTools`).
- Tools + planning: `root/src/agent/tools/index.ts` (CONTROL JSON planner, vectara/search/deepResearch/Amadeus).
- LLM adapters: `root/src/core/llm.ts` (callLLM, chatWithToolsLLM; honours env temps/top_p/top_k/max tokens).
- Session & context: `root/src/core/session_store.ts`, `stores/{inmemory,redis}.ts` (no message cap when `SESSION_MAX_MESSAGES=0`).
- Receipts & verification: `root/src/core/slot_memory.ts`, `core/verify.ts` (strict JSON, shared by auto-verify & `/why`).
- Metrics & dashboard: `root/src/util/metrics.ts`, `util/metrics-server.ts`, `root/public/metrics-dashboard.html`.
- Resilience & rate limits: `root/src/core/circuit-breaker.ts`, `util/limiter.ts`, Bottleneck/cockatiel wiring in tools.
