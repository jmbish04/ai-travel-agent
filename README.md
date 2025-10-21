# Voyant Travel Assistant

Single meta‑agent pipeline that plans tool calls, executes, writes receipts,
and verifies before reply. Built for fast, trustworthy answers with clear
provenance and resilient I/O.

## Implementations

This repository contains two implementations:

### 🌐 Cloudflare Workers Implementation (New)
**Location**: `travel-agent-worker/`

Serverless, edge-computing implementation using Cloudflare's platform:
- **Cloudflare Workers**: Main API endpoints
- **Durable Objects**: Stateful agent instances  
- **D1 Database**: Structured data storage
- **R2**: File storage for scraped content
- **KV**: Fast caching and sessions
- **Vectorize**: Vector database for semantic search
- **Browser Rendering**: Web scraping capabilities
- **Queues**: Async task processing

See `travel-agent-worker/README.md` for setup and deployment instructions.

### 🖥️ Node.js Implementation (Original)
**Location**: `root/`

Traditional Node.js/Express backend with Redis storage.

Quick start: `cd root && npm install && npm run build && npm run start`.
For CLI: `cd root && npm run cli`. Minimal env: `LLM_PROVIDER_BASEURL` +
`LLM_API_KEY` (or `OPENROUTER_API_KEY`), plus optional Amadeus/Vectara/Search
keys when those tools are used.

Architecture focuses on AI‑first planning (OpenAI‑style tools), strict JSON
parsing via Zod, non‑blocking async I/O with explicit timeouts/signals, and a
verification pipeline that stores receipts and artifacts for `/why`.

**Testing**

- Layers
  - Unit: pure modules (schemas, parsers, helpers). No network.
  - Integration: tool adapters and API routes with HTTP mocked.
  - Golden: real meta‑agent conversations that persist receipts, then call the
    verifier (verify.md) via an LLM pass‑through; assertions read the stored
    verification artifact (no re‑verify on `/why`).

- Commands
  - `cd root && npm run test:unit`
  - `cd root && npm run test:integration`
  - `cd root && VERIFY_LLM=1 AUTO_VERIFY_REPLIES=true npm run test:golden`

- Golden prerequisites
  - Provide `LLM_PROVIDER_BASEURL` + `LLM_API_KEY` or `OPENROUTER_API_KEY`.
  - Golden tests are skipped unless `VERIFY_LLM=1`.


**Agent Decision Flow**

```mermaid
flowchart TD
  U["User message"] --> API["POST /chat\\nroot/src/api/routes.ts"]
  API --> HANDLE["handleChat()\\nroot/src/core/blend.ts"]
  HANDLE --> RUN["runMetaAgentTurn()\\nroot/src/agent/meta_agent.ts"]

  subgraph MetaAgent["Meta Agent\\nAnalyze → Plan → Act → Blend"]
    RUN --> LOAD["Load meta_agent.md\\nlog prompt hash/version"]
    LOAD --> PLAN["Analyze + Plan (LLM)\\nCONTROL JSON route/missing/calls"]
    PLAN --> ACT["chatWithToolsLLM()\\nexecute tool plan"]
    ACT --> BLEND["Blend (LLM) grounded reply"]

    subgraph Tools["Tools Registry\\nroot/src/agent/tools/index.ts"]
      ACT --> T1["weather / getCountry / getAttractions"]
      ACT --> T2["searchTravelInfo (Tavily/Brave)"]
      ACT --> T3["vectaraQuery (RAG locator)"]
      ACT --> T4["extractPolicyWithCrawlee / deepResearch"]
      ACT --> T5["Amadeus resolveCity / airports / flights"]
    end

    BLEND --> RECEIPTS["setLastReceipts()\\nslot_memory.ts"]
  end

  RECEIPTS --> MET["observeStage / addMeta* metrics\\nutil/metrics.ts"]
  MET --> AUTO{"AUTO_VERIFY_REPLIES=true?"}
  AUTO -->|Yes| VERIFY["verifyAnswer()\\ncore/verify.ts\\nctx: getContext + slots + intent"]
  VERIFY --> STORE["setLastVerification()\\nslot_memory.ts"]
  VERIFY --> VERDICT{"verdict = fail & revised answer?"}
  VERDICT -->|Yes| REPLACE["Use revised answer\\npushMessage(thread, revised)"]
  VERDICT -->|No| FINAL["Return meta reply"]
  STORE --> FINAL
  AUTO -->|No| FINAL
  REPLACE --> FINAL

  FINAL --> RESP["ChatOutput → caller"]
  RESP --> WHY["/why command\\nreads receipts + stored verification"]
```

**Prompts Flow**

```mermaid
flowchart TD
  U["User message"] --> SYS["meta_agent.md<br/>System prompt"]
  SYS --> PLAN["Planning request (LLM)<br/>CONTROL JSON route/missing/calls"]
  PLAN --> ACT["chatWithToolsLLM<br/>Meta Agent execution"]
  ACT --> BLEND["Blend instructions<br/>within meta_agent.md"]
  BLEND --> RECEIPTS["Persist receipts\\nslot_memory.setLastReceipts"]
  RECEIPTS --> VERQ{"Auto-verify or /why?"}
  VERQ -->|Yes| VERIFY["verify.md<br/>STRICT JSON verdict"]
  VERIFY --> OUT["Reply + receipts"]
  VERQ -->|No| OUT
```

Docs: see `docs/index.html` for quick links to prompts/observability.
