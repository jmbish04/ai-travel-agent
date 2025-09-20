# Graph Explanation: How Branching Works and Where Prompts Are Used

This document supplements the AGENT_DECISION_FLOW.md and PROMPTS_FLOW.md diagrams with a "top-down" description, focusing on:
- what each node is responsible for;
- what branches are possible and under what conditions we enter a particular branch;
- where prompts are used (and why);
- where branches conclude with a response (ChatOutput) and where we return for clarification.

Important: Intent detection at runtime is handled by a single router (src/core/router.ts → routeIntent). All other NLP/LLM prompts are
auxiliary slot/hint extractors, not competing route classifiers. This will be explicitly noted below.

---

## Agent Decision Flow (AGENT_DECISION_FLOW.md)

The flow follows the G-E-R-A pattern: Guard → Extract → Route → Act.

1) Guard (fast checks)
- Consent flag check (slot_memory.readConsentState). If the user responds "yes/no" to a previously asked consent question,
  we process the short answer (checkYesNoShortcut → classifyConsentResponse), clear the flags, and either immediately perform the deferred action
  (web/deep search) or decline and end the turn (ChatOutput).
- Optional weather fast-path (based on an env flag). If the query is about "weather now/today", we try to quickly extract the city via
  city_parser and immediately return a response from weatherNode. This branch ends the turn (→ Z → ChatOutput).
- "Search upgrade?" When there is a previous_query (last web search), the search_upgrade_detector checks if the user requested to
  "dig deeper/continue". If positive, we immediately perform deep research (performDeepResearchNode) and end the turn.

2) Extract (one-time data preparation per turn)
- buildTurnCache — minimal input normalization.
- routeIntent — THE ONLY decision point for intent:
  - transformers-first (without LLM) initially;
  - if confidence is insufficient → a single call to router_llm.md (LLM returns intent + slots).
- For flights, post-enrichment of slots (flight_slot_extractor) is performed, preserving relative dates ("today", "tomorrow").
- For lightweight cases (weather/packing/attractions/destinations) — city extraction (city_parser), etc.
- If necessary — content classification (transformers) for filtering "unrelated" content.

3) Route (slot handling and missing fields)
- normalizeSlots combines the previous state and new slots, cleans placeholders/temporary values.
- checkMissingSlots verifies mandatory slots. If something is missing (e.g., city/dates) — a clarifying question is constructed via
  buildClarifyingQuestion (internally — nlp_clarifier). This branch immediately ends with a clarifying response (→ Z → ChatOutput) and awaits a reply.

4) Act (domain nodes)
- Branching by intent (this is not a second "detect"; it's using the router's result):
  - weather → weatherNode: calls Open-Meteo (or fallback), forms a brief response. → Z → ChatOutput.
  - attractions → attractionsNode: first OpenTripMap; for family profiles — filtering via transformers/LLM (attractions_kid_friendly),
    then attractions_summarizer. → Z → ChatOutput.
  - packing → packingNode: facts are gathered (weather, etc.), then the response is assembled (see blend below). → Z → ChatOutput.
  - destinations → destinationsNode: preferences (preference_extractor) → candidates (destinations_recommender) → response assembly. → Z.
  - policy → PolicyAgent: Vectara RAG + policy_quality_assessor; if quality is insufficient — browser "receipts" (Playwright) +
    policy_confidence + final policy_summarizer. If still insufficient — ask consent for web_after_rag. → Z → ChatOutput.
  - flights → flightsNode/IRROPS: via internal mechanisms for alternative search, constraint validation, and ranking. → Z → ChatOutput.
  - web_search → webSearchNode: search_query_optimizer → search_summarize → (optionally LLM extractors) → Z → ChatOutput.
  - system → systemNode: service responses (including deep research confirmation with consent). → Z → ChatOutput.
  - unknown → unknownNode: safe general assembly via blend. → Z → ChatOutput.

5) Response Completion
- Compose Final Answer (Z): saves receipts (facts/decisions), if the /why flag or receipts=true — verify.md (self-check) and possibly
  adjusts the response. Returns ChatOutput.

Result: Any branch, including weather fast-path, deep-research continuation, clarifying question, and system, ends in Z → ChatOutput.

---

## Prompts Flow (PROMPTS_FLOW.md)

This diagram shows which prompts are involved and how they are logically connected.

Input and Routing
- system.md — system behavior rules.
- search_upgrade_detector.md — if there is a previous_query, determines "continue search deeper?"; on upgrade → deep research (below).
- router_llm.md — used by the router only when transformers-first did not yield a confident result. This is the only intent "detection".
- context_switch_detector.md — helps understand context changes; affects slot clearing but does not "reclassify" intent independently.

NLP/Slots (auxiliary prompts, not an alternative router)
- nlp_intent_detection.md — extracts hints/slots (used in parsers.ts), but the final intent is still from routeIntent.
- city_parser.md / origin_destination_extractor.md / date_parser.md — populate/refine slots for city/OD/dates; results go to the
  Missing Slots (MS) node. If something is still missing after merging — nlp_clarifier.md forms one clarifying question and we return to the user (OUT/ChatOutput).

Consent / Deep Research
- complexity_assessor.md → consent_detector.md — for complex queries (and DEEP_RESEARCH_ENABLED) we ask for consent for "deep" research.
  - Yes / deep → deep research (crawlee_page_summary.md → crawlee_overall_summary.md → sources/citations → Z)
  - Yes / web → standard web_search path
  - No → immediately Z with the current branch (or with refusal to search)

Policy
- policy_classifier.md — domain selection (airlines/hotels/visas) at the PolicyAgent level.
- policy_summarizer.md — response assembly from RAG/receipts.
- policy_quality_assessor.md — quality assessment: decides if RAG citations are sufficient or if browser/web is needed.
- policy_confidence.md — scoring excerpts from browser mode.

Web Search and Extractions
- search_query_optimizer.md — improves the web query.
- search_summarize.md — synthesizes search results (LLM if necessary). Then, if available, thematic extractions are applied:
  - search_extract_weather.md / search_extract_country.md / search_extract_attractions.md — help gather short facts.
  After this, sources go through citation_analysis.md / citation_verification.md and end up in Z.

Narrative / Final Assembly
- blend_planner.md — selects response style and builds the plan.
- cot.md + system.md — "private" reasoning markup.
- blend.md + system.md — final response composition. From here, we go directly to Z (the diagram now explicitly shows this).

Where Branches "Flow"
- Clarifying question (nlp_clarifier.md) → OUT → ChatOutput (ends the turn).
- attractions_summarizer.md → Z → ChatOutput.
- destinations_recommender.md → BLEND → Z → ChatOutput.
- Any domain node (weather/packing/attractions/destinations/flights/policy/web_search/unknown/system) → Z → ChatOutput.

Useful Notes on "Double Detection"
- In the code, intent detection is single: routeIntent (transformers-first → router_llm). The INT node in the diagram is branching based on the ALREADY selected
  intent, not a re-classification. nlp_intent_detection in the diagram is left as an auxiliary prompt for slots; it is connected to
  slot nodes and Missing Slots, and no longer appears as a second detector.

---

## Frequently Asked Questions

Why both nlp_intent_detection and router_llm simultaneously?
- router_llm is only needed as a fallback after transformers-first and it provides the final intent.
- nlp_intent_detection is a cheap way to pull slots/hints (does not "vote" for intent), which helps avoid unnecessary clarifications.

Why do some chains end immediately (do not go to CITATION/VERIFY)?
- For API responses (weather, OpenTripMap), we give a short answer and sources are explicitly mentioned; self-check (verify.md) is performed only when
  the user requested receipts or /why — this corresponds to the code in api/routes.ts and core/blend.ts.

Is it possible to combine several prompts into one?
- Theoretically yes (e.g., city/date/OD), but the current diagram reflects the actual implementation: individual prompts are called specifically,
  to avoid proliferating expensive LLM calls where local rules or transformers would suffice.
