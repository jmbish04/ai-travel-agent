# Core Modules Documentation

This document provides a detailed overview of each module in the `/src/core` directory, explaining what it does, where it's used, and whether it uses Transformers or LLM approaches.

## Module Index

### Active Modules (Using Transformers)

1. [ner.ts](#nerts) - Unified NER facade with local/remote/auto fallback and IPC support for test environments
2. [ner-enhanced.ts](#ner-enhancedts) - Enhanced NER with business logic, pattern detection, and entity normalization
3. [transformers-classifier.ts](#transformers-classifierts) - Content and intent classification with child process support for testing
4. [transformers-detector.ts](#transformers-detectorts) - Language and script detection with confidence scoring
5. [transformers-env.ts](#transformers-envts) - Transformers.js environment configuration
6. [transformers-nlp-facade.ts](#transformers-nlp-facadets) - Unified NLP processing facade with structured results
7. [transformers-attractions-classifier.ts](#transformers-attractions-classifierts) - Family-friendly attraction classification with confidence scoring
8. [transformers-consent-classifier.ts](#transformers-consent-classifierts) - Consent response classification using Transformers
9. [ner-ipc.ts](#ner-ipcts) - IPC wrapper for running Transformers in child processes

### Active Modules (Using LLM)

10. [llm.ts](#llmts) - Unified LLM interface with model fallback, circuit breaker, and batch operations
11. [clarifier.ts](#clarifierts) - Clarifying question generation with LLM fallback to deterministic logic
12. [deep_research.ts](#deep_researchts) - Multi-pass deep research with query optimization and synthesis
13. [blend.planner.ts](#blendplannerts) - LLM-based planning for blend operations and query strategy determination

### Active Modules (Hybrid - Using Both Transformers and LLM)

14. [blend.ts](#blendts) - Main response orchestration with external API integration and web search
15. [graph.ts](#graphts) - Core decision graph with G-E-R-A pattern and unified consent handling
16. [nlp.ts](#nlpts) - NLP utilities with both Transformers detection and LLM classification
17. [parsers.ts](#parsersts) - Universal parsing with AI-first approaches and confidence scoring
18. [policy_agent.ts](#policy_agentts) - Policy query handling with Vectara RAG and LLM reasoning
19. [preference-extractor.ts](#preference-extractorts) - Travel preference extraction using both NLP and LLM
20. [router.ts](#routerts) - Intent routing with Transformers → LLM → rules cascade
21. [search-query-optimizer.ts](#search-query-optimizerts) - Search query optimization with Transformers and LLM enhancement
22. [search-result-extractor.ts](#search-result-extractorts) - Web search result extraction and summarization
23. [searchSummarizer.ts](#searchsummarizerts) - Search result summarization with LLM and deterministic fallback
24. [graph.optimizers.ts](#graphoptimizersts) - Graph processing optimization with regex patterns and fast-path routing
25. [citations.enhanced.ts](#citationsenhancedts) - Enhanced citation analysis with LLM-powered verification
26. [irrops_engine.ts](#irrops_enginetts) - IRROPS processing with constraint validation and option ranking
27. [option_ranker.ts](#option_rankerts) - Rebooking option ranking with preference-based scoring

### Active Modules (Utility)

28. [circuit-breaker.ts](#circuit-breakerts) - Circuit breaker pattern with configurable thresholds and monitoring
29. [citations.ts](#citationsts) - Citation management with enhanced features re-exported
30. [memory.ts](#memoryts) - Conversation memory management with thread isolation
31. [prompts.ts](#promptsts) - Prompt template management with lazy loading and preloading
32. [rate-limiter.ts](#rate-limiterts) - Rate limiting with token bucket algorithm and concurrent request control
33. [receipts.ts](#receiptsts) - Fact tracking and receipts skeleton generation
34. [slot_memory.ts](#slot_memoryts) - Slot memory management with consent state handling
35. [verify.ts](#verifyts) - Answer verification using LLM with structured result schema
36. [composers.ts](#composersts) - Deterministic response composition for weather, packing, and attractions
37. [constraint_validator.ts](#constraint_validatorts) - MCT and fare rule validation for IRROPS
38. [constraintGraph.ts](#constraintgraphts) - Constraint graph management for complexity assessment
39. [router.optimizers.ts](#routeroptimizersts) - Router optimization with regex patterns and heuristics


## Module Details

### Active Modules (Using Transformers)

#### ner.ts
**What it does:** Unified NER facade with intelligent strategy selection (local/remote/auto) using Transformers.js. Supports multiple model configurations, automatic fallback mechanisms, IPC for test environments (avoiding Jest/ORT typed array issues), and timeout management. Handles entity extraction with confidence scoring and model selection based on task type.
**Where used:** Used by `ner-enhanced.ts`, `transformers-nlp-facade.ts`, `parsers.ts`, and other modules requiring named entity recognition.
**Technology:** Transformers
**Relationship:** This is the foundational module that `ner-enhanced.ts` extends with business logic and pattern-based detection.

#### ner-enhanced.ts
**What it does:** Provides enhanced named entity recognition with improved entity extraction and scoring using Transformers. This module adds business logic, enhanced categorization, and pattern-based detection on top of the basic NER functionality.
**Where used:** Used by `graph.ts`, `router.ts`, and other modules requiring advanced NER capabilities with categorized entities.
**Technology:** Transformers
**Relationship:** This module imports and extends `ner.ts` to provide enhanced functionality.

#### transformers-classifier.ts
**What it does:** Provides content and intent classification using transformer models.
**Where used:** Used by various modules requiring content/intent classification.
**Technology:** Transformers

#### transformers-detector.ts
**What it does:** Detects languages and script types in text using transformer models.
**Where used:** Used by `nlp.ts` and other modules requiring language detection.
**Technology:** Transformers

#### transformers-env.ts
**What it does:** Configures the Transformers.js environment for proper model loading and execution.
**Where used:** Imported by `ner.ts` and other modules using Transformers.js.
**Technology:** Transformers

#### transformers-nlp-facade.ts
**What it does:** Provides a facade for unified NLP processing using transformers.
**Where used:** Used by `graph.ts` for NLP processing.
**Technology:** Transformers

#### transformers-attractions-classifier.ts
**What it does:** Classifies attractions using Transformers for content analysis, with LLM fallback for family-friendly filtering. Implements kid-friendly attraction detection using both NLP patterns and LLM reasoning.
**Where used:** Used by `tools/attractions.ts` for filtering attractions based on family-friendly criteria.
**Technology:** Transformers (primary), LLM (fallback)

#### transformers-consent-classifier.ts
**What it does:** Classifies user consent responses using NLP (Transformers) techniques.
**Where used:** Used by `graph.ts` for consent detection.
**Technology:** Transformers

#### ner-ipc.ts
**What it does:** Implements IPC (Inter-Process Communication) for running NER models in child processes to avoid Jest/ORT typed array issues.
**Where used:** Used by `ner.ts` in test environments.
**Technology:** Transformers

### Active Modules (Using LLM)

#### llm.ts
**What it does:** Unified LLM interface with model fallback chain, circuit breaker protection, batch operations, and response format handling. Supports multiple providers (OpenRouter, custom base URLs), automatic model selection, timeout management, and structured JSON parsing. Includes fallback stub for offline testing.
**Where used:** Used throughout the core modules for LLM interactions, specialized NLP tasks, and batch processing.
**Technology:** LLM

#### router.llm.ts
**What it does:** Implements LLM-based routing for determining user intents and extracting slots.
**Where used:** Used by `router.ts` as a fallback routing mechanism.
**Technology:** LLM

#### clarifier.ts
**What it does:** Builds clarifying questions when information is missing from user queries, using both LLM and fallback logic.
**Where used:** Used by `graph.ts` to ask users for missing information.
**Technology:** LLM

#### deep_research.ts
**What it does:** Multi-pass deep research with query optimization, parallel search execution, deduplication, and LLM-powered synthesis. Supports both Crawlee deep research and regular search with configurable complexity detection. Includes citation management and confidence scoring.
**Where used:** Used by `blend.ts` when deep research is required or when `DEEP_RESEARCH_ENABLED=true`.
**Technology:** LLM

#### blend.planner.ts
**What it does:** LLM-based planning for blend operations using structured prompt templates. Analyzes user messages to determine query facets, safety checks, response strategies, web search needs, language handling, missing slots, and response formatting. Returns structured BlendPlan with explicit flags for different processing paths.
**Where used:** Used by `blend.ts` and `graph.ts` to plan how to handle user queries and determine what external APIs or web searches are needed.
**Technology:** LLM

### Active Modules (Hybrid - Using Both Transformers and LLM)

#### blend.ts
**What it does:** Main response orchestration engine that blends facts from external APIs with LLM-generated responses. Handles complex chat interactions, web searches, fact verification, consent detection, and query type classification. Implements sophisticated safety guardrails, mixed-language support, and receipts-based transparency. Includes fallback mechanisms for API failures and structured error handling.
**Where used:** Used by `graph.ts` and `handleChat` as the main response generation engine for user queries.
**Technology:** Both Transformers and LLM

#### graph.ts
**What it does:** Core decision graph implementing G-E-R-A pattern (Guard → Extract → Route → Act) for processing user intents and routing to handlers. Features unified consent handling, single-pass extraction with caching, fast-path routing, and complex slot management. Includes AI-first consent detection and thread-safe conversation state management.
**Where used:** Central module used by `handleChat` and `runGraphTurn` for processing user requests and managing conversation state.
**Technology:** Both Transformers and LLM

#### nlp.ts
**What it does:** Provides general NLP utilities and functions for content classification and language detection.
**Where used:** Used by various modules requiring NLP capabilities.
**Technology:** Both Transformers and LLM

#### parsers.ts
**What it does:** Provides universal parsing functions for extracting cities, dates, intents, and slots from text using AI-first approaches. Implements Transformers NER with LLM fallback, confidence scoring, and schema validation.
**Where used:** Used by `router.ts`, `router.llm.ts`, and other modules requiring entity extraction and slot filling.
**Technology:** Both Transformers and LLM

#### policy_agent.ts
**What it does:** Handles policy-related queries and routing.
**Where used:** Used by `graph.ts` for policy-related intent handling.
**Technology:** Both Transformers and LLM

#### preference-extractor.ts
**What it does:** Extracts user travel preferences from text using AI techniques.
**Where used:** Used by `graph.ts` for preference extraction.
**Technology:** Both Transformers and LLM

#### router.ts
**What it does:** Main router that determines user intents and routes them to appropriate handlers using a cascade of techniques.
**Where used:** Used by `graph.ts` for intent routing.
**Technology:** Both Transformers and LLM

#### search-query-optimizer.ts
**What it does:** Optimizes search queries for better web search results.
**Where used:** Used by `blend.ts` and other modules requiring search optimization.
**Technology:** Both Transformers and LLM

#### search-result-extractor.ts
**What it does:** Extracts relevant information from web search results.
**Where used:** Used by `blend.ts` for processing search results.
**Technology:** Both Transformers and LLM

#### searchSummarizer.ts
**What it does:** Summarizes web search results using LLM with deterministic fallback for concise, well-formatted responses. Handles HTML sanitization, response truncation, and citation formatting.
**Where used:** Used by `blend.ts` and `graph.ts` for formatting search results into readable responses.
**Technology:** Both Transformers and LLM

#### graph.optimizers.ts
**What it does:** Provides optimization helpers for the graph processing pipeline including guards, cache management, and decision table logic. Implements G-E-R-A pattern (Guard → Extract → Route → Act) with regex patterns and fast-path routing.
**Where used:** Used by `graph.ts` for efficient request processing and fast-path routing.
**Technology:** Both Transformers and LLM

### Active Modules (Utility)

#### circuit-breaker.ts
**What it does:** Implements circuit breaker pattern with configurable failure/success thresholds, timeout management, and monitoring. Features CLOSED/HALF_OPEN/OPEN states, automatic recovery, and comprehensive metrics collection. Uses Zod schemas for configuration validation.
**Where used:** Used by `llm.ts` for LLM API resilience and other modules making external API calls.
**Technology:** Utility

#### citations.ts
**What it does:** Manages citations and verifies that responses don't fabricate information without proper sources.
**Where used:** Used by `blend.ts` and other modules that generate responses requiring citations.
**Technology:** Utility

#### memory.ts
**What it does:** Manages conversation memory and message history for chat interactions.
**Where used:** Used by `blend.ts` and `cli.ts` for maintaining conversation context.
**Technology:** Utility

#### prompts.ts
**What it does:** Manages prompt templates for various LLM interactions.
**Where used:** Used by `llm.ts` and other modules requiring prompt templates.
**Technology:** Utility

#### rate-limiter.ts
**What it does:** Rate limiting implementation with token bucket algorithm, concurrent request control, and configurable limits. Features automatic token refill, queue management, and metrics collection for monitoring usage patterns.
**Where used:** Used by `cli.ts` and `api/server.ts` for preventing abuse and managing resource usage.
**Technology:** Utility

#### receipts.ts
**What it does:** Manages receipts/facts tracking for transparency and verification of information sources.
**Where used:** Used by `blend.ts` and other modules generating responses with external facts.
**Technology:** Utility

#### slot_memory.ts
**What it does:** Slot memory management with consent state handling, thread isolation, and slot normalization. Features CLI/memory persistence, expected missing slot tracking, and intent history management. Includes unified consent state management for web search and deep research flows.
**Where used:** Used by `graph.ts` and other modules requiring context retention and consent management.
**Technology:** Utility

#### verify.ts
**What it does:** Answer verification using LLM to ensure responses are factual and properly cited. Features structured result schema with verdict and notes, fact validation against sources, and revision capability when answers fail verification.
**Where used:** Used by `blend.ts` for response verification and `/why` command processing.
**Technology:** LLM

#### composers.ts
**What it does:** Provides deterministic response composition utilities for weather, packing, and attractions replies.
**Where used:** Used by `blend.ts` and `graph.ts` for consistent, formatted response generation.
**Technology:** Utility

#### constraintGraph.ts
**What it does:** Builds and manages constraint graphs for assessing query complexity and routing decisions.
**Where used:** Used by `graph.ts` and `router.ts` for determining processing complexity and optimization strategies.
**Technology:** Utility

#### router.optimizers.ts
**What it does:** Provides router optimization utilities including regex patterns, guards, and heuristics for efficient routing decisions.
**Where used:** Used by `router.ts` for fast-path routing and complexity assessment.
**Technology:** Utility

#### citations.enhanced.ts
**What it does:** Enhanced citation system with LLM-powered features including intelligent citation relevance scoring, quality assessment, automatic formatting, duplicate detection, and citation verification against content. Provides both analysis and verification capabilities.
**Where used:** Used by citation processing pipelines for advanced citation management and verification.
**Technology:** Both Transformers and LLM

#### irrops_engine.ts
**What it does:** IRROPS (Irregular Operations) processing engine with constraint validation, option ranking, and disruption classification. Handles flight cancellations/delays by generating rebooking options with MCT validation, fare rules checking, and carrier change policies.
**Where used:** Used by `graph.ts` for processing flight disruption scenarios and generating rebooking options.
**Technology:** Both Transformers and LLM

#### option_ranker.ts
**What it does:** Rebooking option ranking system with preference-based scoring. Uses configurable weights for price, schedule, carrier, and disruption factors to rank IRROPS options according to user preferences.
**Where used:** Used by `irrops_engine.ts` for ranking generated rebooking options.
**Technology:** Utility

#### constraint_validator.ts
**What it does:** MCT (Minimum Connection Time) and fare rule validation for IRROPS scenarios. Validates connection times, fare change penalties, and carrier change policies against airline rules and user preferences.
**Where used:** Used by `irrops_engine.ts` for validating rebooking options against airline constraints.
**Technology:** Utility
