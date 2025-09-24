# Core Modules Overview (Meta-Agent Architecture)

This repository now runs exclusively on the meta-agent pipeline. Legacy router/graph/NER/Transformers code has been removed.

- **blend.ts** — entry point for chat handling. Routes every turn to `runMetaAgentTurn`, preserves `/why` receipts behaviour, and handles auto-verification.
- **agent/meta_agent.ts** — meta-agent runtime: loads the meta prompt, gathers slot context, runs the tool-calling loop, captures receipts, and updates metrics.
- **agent/tools/index.ts** — OpenAI-style tool registry (weather, attractions, country facts, Amadeus flights, etc.) with Zod validation, Bottleneck limits, cockatiel retries, and meta metrics instrumentation.
- **core/prompts.ts** — loads active prompt files (`meta_agent.md`, verify/consent/search/policy/attractions helpers). PROMPTS_DIR env override still supported.
- **tools/** — domain adapters (weather, Amadeus, search, country, etc.). All transformers/NER dependencies removed.
- **util/metrics.ts** — shared Prometheus/JSON metrics; meta-agent counters (tool calls, latencies, routing confidence, receipts) wired here.
- **core/memory.ts & slot_memory.ts** — conversation threading, slot persistence, receipts storage.

Removed modules: router.ts, graph.ts, blend.planner.ts, composers.ts, clarifier.ts, citations*.ts, search_service.ts, searchSummarizer.ts, search_upgrade.ts, ner*.ts, transformers-*.ts, policy_agent.ts, legacy tests.

CLI defaults to the meta agent; setting `BIG_LLM_MODE=off` is no longer supported.
