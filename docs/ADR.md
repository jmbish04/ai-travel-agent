# Architecture Decision Records (ADRs)

This document captures the major design decisions made while building the travel assistant, with context, options, decisions, and consequences. Evidence links map each ADR to specific code or docs. Commit history references are from `git log` in this repo.

Note on scope: These ADRs reflect the current implementation state as of the latest commits, aligning with the homework goals and the hiring manager’s expectations in `dev/.dev/raw_docs/interview_and_targets_ru.md`.

---

## ADR-001: Orchestration Pattern — G‑E‑R‑A with LangGraph Subgraphs

- Status: Accepted
- Date: 2025-09 (evolving)
- Context
  - Need a conversation flow that behaves like a “real agent” with branching, checkpoints, and parallelizable steps, while keeping demo setup lightweight.
  - Homework and hiring notes emphasize reliability, explicit states, and non-linear flows.
- Options
  1) Single LLM agent loop (simplest, opaque state)
  2) Custom orchestrator only (framework-free)
  3) Hybrid: custom G‑E‑R‑A orchestrator + LangGraph subgraphs where explicit state adds value
- Decision
  - Use custom G‑E‑R‑A (Guard → Extract → Route → Act) in `src/core/graph.ts` for the main path, and apply LangGraph subgraphs for specialized flows (IRROPS and policy browser flow) for explicit routing and easier testing.
- Consequences
  - Clear separation of guards vs extractors vs domain actions; easier to reason about and test.
  - Subgraphs are composable and production-friendly; swapping to Temporal/Step Functions later remains feasible.
- Evidence
  - Code: `src/core/graph.ts`; `src/agent/graphs/irrops.graph.ts`; `src/agent/graphs/policy.browser.graph.ts`
  - Docs: `docs/AGENT_DECISION_FLOW.md`
  - Commits: `74a1a2b`, `512b746` (IRROPS), `be71cb7` (Playwright policy extraction)

---

## ADR-002: Policy Information Strategy — RAG-first with Vectara, Browser Receipts as Fallback

- Status: Accepted
- Context
  - Policy questions demand citations and low hallucination risk.
  - Hiring notes: act like a human, open “browser/terminal” when APIs fail; cite sources.
- Options
  1) RAG only (risk: gaps when corpora incomplete)
  2) Browser-only (fragile under anti-bot, slower, higher variance)
  3) RAG-first + browser receipts fallback (stealth) + summarizer
- Decision
  - Implement `PolicyAgent` that queries Vectara (with FCS-like quality gating). If insufficient, try Playwright receipts extraction against official pages; apply a confidence guard (≥0.6) and summarize receipts with a prompt. If still insufficient, ask for web-search consent (or auto-search for visas).
- Consequences
  - Reduced hallucinations via citations/receipts; graceful degradation under missing data.
  - Additional complexity (stealth, guards), but bounded and measurable.
- Evidence
  - Code: `src/core/policy_agent.ts`, `src/tools/policy_browser.ts`, `src/schemas/vectara.ts`
  - Prompts: `src/prompts/policy_quality_assessor.md`, `policy_extractor.md`, `policy_confidence.md`, `policy_summarizer.md`
  - Commits: `be71cb7`, `eb364f3`, `4029edf`

---

## ADR-003: Anti‑Hallucination — Receipts + Self‑Check Verifier

- Status: Accepted
- Context
  - Homework requires “answers with sources” and explicit uncertainty; hiring notes demand reliability.
- Decision
  - Introduce a `Receipts` card (sources, decisions, budgets). Add `/chat` flag or `/why` trigger to return receipts. Run `verifyAnswer` second pass; if “fail” and revised answer is present, return the revised answer. Store last receipts per thread.
- Consequences
  - Increased trust; minor token/time overhead only when user asks for receipts.
- Evidence
  - Code: `src/api/routes.ts`, `src/core/receipts.ts`, `src/core/verify.ts`, `src/schemas/chat.ts`
  - Tests: `tests/e2e/05-errors_api_failures.test.ts` (graceful failures with no fabrication)

---

## ADR-004: Resilience for External Calls — Dual Breakers + Rate Limiting

- Status: Accepted
- Context
  - APIs fail; need bounded latencies and back-pressure.
- Decision
  - Use `opossum` breaker and Bottleneck limiter for host-level calls (in `util/circuit.ts`, `util/limiter.ts`), and a small typed breaker for Vectara-only (`core/circuit-breaker.ts`) inside the RAG client. Server-level rate limiter middleware protects `/chat`.
- Consequences
  - Fine-grained controls per integration; optional per-host env overrides.
- Evidence
  - Code: `src/util/circuit.ts`, `src/util/limiter.ts`, `src/core/circuit-breaker.ts`, `src/config/resilience.ts`, `src/api/server.ts`

---

## ADR-005: Routing Strategy — Transformers‑First + Single LLM Router

- Status: Accepted
- Context
  - Need fast, deterministic routing with minimal LLM calls; preserve relative dates for flights; support consent flows.
- Decision
  - Apply heuristics/regex and transformers-first path. Fallback to a single LLM router (`router_llm`) with slot enhancement and preservation of relative dates. Unify consent read/write to avoid recursion in clarification.
- Evidence
  - Code: `src/core/router.ts`, `src/core/slot_memory.ts`, `src/core/graph.ts`
  - Prompts: `src/prompts/router_llm.md` (loaded via `core/prompts.ts`)

---

## ADR-006: Metrics Exposure — JSON Snapshot by Default; Prom Optional

- Status: Accepted
- Context
  - Homework asks for mini-metrics; need low-friction local runs and CI.
- Decision
  - Provide `/metrics` JSON snapshot always; enable Prometheus via env without adding a hard dependency.
- Evidence
  - Code: `src/util/metrics.ts`, `src/api/routes.ts`

---

## ADR-007: IRROPS Handling — Subgraph + Amadeus Alternatives + Constraint Validation

- Status: Accepted
- Context
  - Must demonstrate disruption handling with options and rules applied; keep demo scope tight.
- Decision
  - Implement `irropsGraph` and `processIrrops` that generate alternatives via Amadeus, validate MCT/fare/carrier constraints, rank options, and compose a human-readable set of choices. For the demo, skip deep GDS contracts.
- Evidence
  - Code: `src/agent/graphs/irrops.graph.ts`, `src/core/irrops_engine.ts`, `src/tools/amadeus_flights.ts`
  - Commits: `6c3774c`, `00b4d69`, `512b746`, `74a1a2b`

---

## ADR-008: Web Search Consent Model — Explicit User Approval

- Status: Accepted
- Context
  - Minimize unsolicited web calls; be explicit with users.
- Decision
  - Maintain consent flags in thread slots; use Yes/No shortcut guard; write `web_after_rag` consent when RAG insufficient for policy; auto-search only for visas.
- Evidence
  - Code: `src/core/slot_memory.ts` (readConsentState/writeConsentState), `src/core/graph.ts` (guards)

---

## ADR-009: RAG Vendor Abstraction — Thin Client over Vectara

- Status: Accepted
- Context
  - Need citations and semantic search now; keep vendor flexibility later.
- Decision
  - Wrap Vectara with a client that adds TTL cache and breaker; normalize hits/citations via Zod schemas; keep interface narrow to enable a future pgvector/Weaviate swap.
- Evidence
  - Code: `src/tools/vectara.ts`, `src/schemas/vectara.ts`
  - Docs: `docs/VECTARA_SETUP.md`

---

## ADR-010: Browser Fallback Anti‑Bot Tactics — Playwright Stealth

- Status: Accepted
- Context
  - Hostile sites block automation; need reliable extraction for policies.
- Decision
  - Use Playwright with stealth hardening (headers, UA, WebGL/mime/plugins spoof) and confidence guard. Cheerio path disabled to avoid low-quality parses; limited to 1–2 URLs with timeouts.
- Evidence
  - Code: `src/tools/policy_browser.ts`, `src/agent/graphs/policy.browser.graph.ts`
  - Commits: `be71cb7`, `eb364f3`, `4029edf`

---
