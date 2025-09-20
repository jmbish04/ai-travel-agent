flowchart TD
  %% =====================================================
  %% PROMPTS PIPELINE (Navan Travel Assistant)
  %% Color key: Blue(User/System), Green(Routing), Yellow(NLP), Orange(Domain), Red(Citations), Purple(Final)
  %% =====================================================

  %% Entry
  U["User Message"]:::uisys --> S["system.md\n[System behavior & guardrails]"]:::uisys
  %% Detect "search deeper/more" to continue prior web query as deep research
  S --> UPG["search_upgrade_detector.md\n[Detect search upgrade vs last query]"]:::nlp
  UPG -->|upgrade| CR1
  UPG --> R["router_llm.md\n[Intent + slots JSON]"]:::route

  %% NLP & Extraction helpers (parallel refinements)
  R --> NCI["nlp_content_classification.md\n[Content type, explicit search, web needs]"]:::nlp
  R --> NI["nlp_intent_detection.md\n[Intent refine + slots]"]:::nlp
  R --> CSD["context_switch_detector.md\n[Detect context change]"]:::nlp
  CSD --> INT
  NI --> CPARSE["city_parser.md\n[City parsing & normalization]"]:::nlp
  NI --> ODEX["origin_destination_extractor.md\n[Flight origin/destination]"]:::nlp
  NI --> DPARSE["date_parser.md\n[Dates/month inference]"]:::nlp

  %% Missing-slot clarifier
  NI --> MS{Missing slots?}
  MS -->|Yes| CLAR["nlp_clarifier.md\n[Ask one clarifying question]"]:::nlp
  MS -->|No| INT{Intent}
  NCI --> INT

  %% Consent gate (web/deep research)
  INT --> CA["complexity_assessor.md\n[Detect deep research need]"]:::nlp
  CA -->|complex &amp; enabled| CONS["consent_detector.md\n[Yes/No for web/deep research]"]:::uisys
  INT -->|web_search consent needed| CONS
  CONS -->|Yes / web| WS_START
  CONS -->|Yes / deep| CR1
  CONS -->|No| Z

  %% Intent branches → Domain processing prompts
  INT -->|policy| PCLS["policy_classifier.md\n[airlines | hotels | visas]"]:::domain
  INT -->|web_search| WS_START
  INT -->|attractions| AKF["attractions_kid_friendly.md\n[Filter for family-friendly]"]:::domain
  AKF --> AT_SUM["attractions_summarizer.md\n[Summarize POIs]"]:::domain
  INT -->|destinations| PREF["preference_extractor.md\n[Extract travel preferences]"]:::domain
  PREF --> DREC["destinations_recommender.md\n[AI destination candidates]"]:::domain
  INT -->|packing| PLAN["blend_planner.md\n[Plan response: style, needs]"]:::domain
  INT -->|weather| PLAN
  INT -->|system| Z
  INT -->|unknown| CLAR
  INT -->|flights| FSE["flight_slot_extractor.md\n[Post-LLM slot enhancement]"]:::nlp
  FSE --> F_GATE{Live search ok?}

  %% Policy Agent path (RAG → receipts → summarize)
  PCLS --> PSUMM["policy_summarizer.md\n[Compose from policy docs]"]:::domain
  PSUMM --> PQA["policy_quality_assessor.md\n[Info quality / needs web?]"]:::domain
  PQA --> QC{Enough citations?}
  QC -->|Yes| CITANA["citation_analysis.md\n[Score/format citations]"]:::cite
  QC -->|No| PBR["policy_extractor.md\n[Extract clauses via browser receipts]"]:::domain
  PBR --> PCONF["policy_confidence.md\n[Confidence scoring]"]:::domain
  PCONF --> PSUMM
  CITANA --> CITVER["citation_verification.md\n[Verify citations vs content]"]:::cite
  CITVER --> Z

  %% Web Search path
  WS_START["search_query_optimizer.md\n[Optimize web query]"]:::domain --> WS_SUM["search_summarize.md\n[Synthesize results]"]:::domain
  %% LLM extraction helpers on results (used when applicable)
  WS_SUM --> EXW["search_extract_weather.md\n[Extract weather signal]"]:::nlp
  WS_SUM --> EXC["search_extract_country.md\n[Extract country facts]"]:::nlp
  WS_SUM --> EXA["search_extract_attractions.md\n[Extract attractions list]"]:::nlp
  EXW --> CITANA
  EXC --> CITANA
  EXA --> CITANA

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
