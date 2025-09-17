flowchart TD
  %% =====================================================
  %% PROMPTS PIPELINE (Navan Travel Assistant)
  %% Color key: Blue(User/System), Green(Routing), Yellow(NLP), Orange(Domain), Red(Citations), Purple(Final)
  %% =====================================================

  %% Entry
  U["User Message"]:::uisys --> S["system.md\n[System behavior & guardrails]"]:::uisys
  S --> R["router_llm.md\n[Intent + slots JSON]"]:::route

  %% NLP & Extraction helpers (parallel refinements)
  R --> NCI["nlp_content_classification.md\n[Content type, explicit search, web needs]"]:::nlp
  R --> NI["nlp_intent_detection.md\n[Intent refine + slots]"]:::nlp
  NI --> CEX["nlp_city_extraction.md\n[Extract city]"]:::nlp
  CEX --> CNAME["city_name_extractor.md\n[Normalize city names]"]:::nlp
  CNAME --> CPARSE["city_parser.md\n[City parsing & normalization]"]:::nlp
  NI --> ODEX["origin_destination_extractor.md\n[Flight origin/destination]"]:::nlp
  NI --> DPARSE["date_parser.md\n[Dates/month inference]"]:::nlp

  %% Missing-slot clarifier
  NI --> MS{Missing slots?}
  MS -->|Yes| CLAR["nlp_clarifier.md\n[Ask one clarifying question]"]:::nlp
  MS -->|No| INT{Intent}
  NCI --> INT

  %% Consent gate (web/deep research)
  INT -->|web_search consent needed| CONS["consent_detector.md\n[Yes/No for web/deep research]"]:::uisys
  CONS -->|Yes| WS_START
  CONS -->|No| Z

  %% Intent branches → Domain processing prompts
  INT -->|policy| PCLS["policy_classifier.md\n[airlines | hotels | visas]"]:::domain
  INT -->|web_search| WS_START
  INT -->|attractions| AT_SUM["attractions_summarizer.md\n[Summarize POIs]"]:::domain
  INT -->|destinations| PREF["preference_extractor.md\n[Extract travel preferences]"]:::domain
  INT -->|packing| PLAN["blend_planner.md\n[Plan response: style, needs]"]:::domain
  INT -->|weather| PLAN
  INT -->|system| Z
  INT -->|unknown| CLAR
  INT -->|flights| F_GATE{Live search ok?}

  %% Policy Agent path (RAG → receipts → summarize)
  PCLS --> PSUMM["policy_summarizer.md\n[Compose from policy docs]"]:::domain
  PSUMM --> QC{Enough citations?}
  QC -->|Yes| CITANA["citation_analysis.md\n[Score/format citations]"]:::cite
  QC -->|No| PBR["policy_extractor.md\n[Extract clauses via browser receipts]"]:::domain
  PBR --> PCONF["policy_confidence.md\n[Confidence scoring]"]:::domain
  PCONF --> PSUMM
  CITANA --> CITVER["citation_verification.md\n[Verify citations vs content]"]:::cite
  CITVER --> Z

  %% Web Search path
  WS_START["search_query_optimizer.md\n[Optimize web query]"]:::domain --> WS_SUM["search_summarize.md\n[Synthesize results with citations]"]:::domain
  WS_SUM --> CITANA

  %% Deep Research (conditional)
  WS_START -->|DEEP_RESEARCH_ENABLED| CR1["crawlee_page_summary.md\n[Per-page summaries]"]:::domain
  CR1 --> CR2["crawlee_overall_summary.md\n[Aggregate summary]"]:::domain
  CR2 --> CITANA

  %% Flights path (fallback to web when API fails)
  F_GATE -->|Yes| Z
  F_GATE -->|API fails or no results| WS_START

  %% Destinations/Packing/Weather narrative generation when needed
  PLAN --> COT["cot.md\n[Private reasoning scaffold]"]:::domain
  COT --> BLEND["blend.md\n[Compose final, cite tools when used]"]:::domain
  BLEND --> CITANA

  %% Compose final answer and optional self-check
  Z["Compose Final Answer"]:::domain --> CHK{Receipts or /why?}
  CHK -->|Yes| VER["verify.md\n[Final answer audit]"]:::final
  CHK -->|No| OUT
  VER --> OUT
  OUT["Return to user"]:::uisys

  %% Classes (colors)
  classDef uisys fill:#D8E8FF,stroke:#1E64D3,color:#0A2E6C;
  classDef route fill:#CFFFD2,stroke:#2A6B2E,color:#0E3D19;
  classDef nlp fill:#FFF6BF,stroke:#C7A600,color:#5A4B00;
  classDef domain fill:#FFD7B5,stroke:#D17C00,color:#5A2E00;
  classDef cite fill:#FFB3B3,stroke:#C11717,color:#5A0000;
  classDef final fill:#E0C6FF,stroke:#6A1B9A,color:#3B0A5E;
