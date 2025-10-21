# Plan to Retrofit Travel Agent Backend to Cloudflare Workers

## Executive Summary

This document outlines a comprehensive plan to migrate the existing Node.js-based travel agent backend to a serverless architecture running on Cloudflare Workers. This migration will leverage a suite of Cloudflare's products to create a more scalable, resilient, and cost-effective solution. The core of this plan is to replace the Express server with Cloudflare Workers, the Redis database with a combination of KV, D1, and R2, and the existing agentic and scraping logic with Cloudflare-native solutions like the Agents SDK, Browser Rendering, and Vectorize.

## High-Level Architecture

The proposed architecture will be composed of the following components:

*   **Cloudflare Worker:** The main entry point for all API requests. It will handle routing, authentication, and orchestration of the various services.
*   **Agents SDK (on Durable Objects):** The core of the agentic logic. Each user session or travel plan will be managed by a dedicated agent instance, providing a stateful and scalable conversation model.
*   **Browser Rendering:** Used for web scraping tasks, such as retrieving hotel availability, flight details, and other information from third-party websites.
*   **Cloudflare Queues:** To decouple the main application from long-running scraping tasks, making the application more resilient and responsive.
*   **Cloudflare Workflows:** To orchestrate complex, multi-step processes, such as a full travel planning itinerary.
*   **Cloudflare D1:** A serverless SQL database for storing structured data like user profiles, trip details, and booking information.
*   **Cloudflare R2:** An S3-compatible object store for unstructured data like scraped web pages, images, and user-uploaded documents.
*   **Cloudflare KV:** A key-value store for caching frequently accessed data, session information, and user preferences.
*   **Cloudflare Vectorize:** A vector database for storing embeddings of hotels, attractions, and user reviews to power semantic search and recommendation features.
*   **Workers AI:** To generate embeddings for the content to be stored in Vectorize.

## Detailed Retrofit Plan

### 1. Browser Rendering for Web Scraping

The existing scraping logic, which uses `crawlee` and `playwright`, will be migrated to Cloudflare's Browser Rendering service.

*   **Replace `playwright` with `@cloudflare/playwright`:** The Cloudflare-optimized version of Playwright will be used to control the headless browser.
*   **Use Browser Binding:** A `browser` binding will be added to the `wrangler.toml` file to provide access to the Browser Rendering service.
*   **Agentic Control with Playwright MCP:** The `@cloudflare/playwright-mcp` library will be used for more robust, LLM-based agentic control of the browser, leveraging the accessibility tree for more reliable interactions.
*   **Asynchronous Scraping with Queues:** Scraping tasks will be initiated by sending a message to a Cloudflare Queue. A dedicated consumer Worker with the Browser Rendering binding will process these messages, perform the scraping, and store the results in R2 or D1.

### 2. Agentic Core with Agents SDK and Durable Objects

The agentic logic will be refactored to use the Cloudflare Agents SDK, which is built on top of Durable Objects.

*   **Create Agent Classes:** The core agent logic will be encapsulated in classes that extend the `Agent` class from the Agents SDK.
*   **Durable Object Binding:** A `durable_objects` binding will be added to the `wrangler.toml` file to link the agent classes to Durable Object namespaces.
*   **State Management:** The state of each agent, including the conversation history and user context, will be stored in the per-agent SQLite database provided by the Agents SDK. This will replace the need for Redis.
*   **Real-time Communication:** WebSockets will be used for real-time communication between the client and the agent, providing a more interactive user experience.

### 3. Data Layer with R2, D1, and KV

The existing Redis dependency will be replaced with a combination of Cloudflare's storage products.

*   **R2 for Unstructured Data:** Scraped web pages, user-uploaded documents, and other large, unstructured data will be stored in R2.
*   **D1 for Structured Data:** User profiles, trip itineraries, booking information, and other relational data will be stored in D1.
*   **KV for Caching and Session Data:** Session tokens, user preferences, and cached API responses will be stored in KV for low-latency access.

### 4. Asynchronous Tasks with Queues and Workflows

Long-running and asynchronous tasks will be managed using Cloudflare Queues and Workflows.

*   **Queues for Simple Tasks:** Simple, one-off tasks like scraping a single web page will be handled by sending a message to a Queue.
*   **Workflows for Complex Processes:** More complex, multi-step processes, such as planning a full trip itinerary, will be orchestrated using Workflows. This will provide better resilience and state management for long-running tasks.

### 5. Vectorization with Vectorize and Workers AI

Semantic search and recommendation features will be implemented using Cloudflare Vectorize and Workers AI.

*   **Generate Embeddings with Workers AI:** The `@cf/baai/bge-base-en-v1.5` model in Workers AI will be used to generate embeddings for hotels, attractions, and user reviews.
*   **Store Embeddings in Vectorize:** The generated embeddings will be stored in a Vectorize index.
*   **Implement RAG:** A Retrieval Augmented Generation (RAG) architecture will be used to provide context-aware responses to the user. The user's query will be used to search the Vectorize index for relevant information, which will then be fed to a large language model to generate a response.

## Step-by-Step Migration Guide

1.  **Set up a new Cloudflare Workers project:** Create a new project and configure the `wrangler.toml` file with the necessary bindings for Browser Rendering, Durable Objects, D1, R2, KV, and Vectorize.
2.  **Migrate the API server:** Replace the Express server with a Cloudflare Worker. This will involve rewriting the routing logic to use the Worker's `fetch` handler.
3.  **Migrate the data layer:**
    *   Create D1 databases for the structured data.
    *   Create R2 buckets for the unstructured data.
    *   Create KV namespaces for caching and session data.
    *   Replace all Redis calls with the appropriate Cloudflare storage client.
4.  **Migrate the scraping logic:**
    *   Replace the `playwright` dependency with `@cloudflare/playwright`.
    *   Create a new consumer Worker with the Browser Rendering binding.
    *   Set up a Cloudflare Queue to handle scraping requests.
    *   Rewrite the scraping logic to be triggered by messages from the Queue.
5.  **Migrate the agentic logic:**
    *   Refactor the agent logic into classes that extend the `Agent` class from the Agents SDK.
    *   Configure the Durable Object bindings in the `wrangler.toml` file.
    *   Replace the existing state management with the per-agent SQLite database.
6.  **Implement vectorization:**
    *   Create a Vectorize index.
    *   Create a new Worker to generate embeddings using Workers AI and store them in the Vectorize index.
    *   Implement the RAG architecture to provide context-aware responses.
7.  **Testing:**
    *   Write unit tests for the individual components using `vitest`.
    *   Write end-to-end tests that deploy the Worker to a local dev server and make HTTP requests to it.

## TODO List

-   [x] Set up Cloudflare Workers project
-   [x] Configure `wrangler.toml` with all necessary bindings
-   [x] Migrate Express routes to Worker `fetch` handler
-   [x] Create D1 database schemas
-   [ ] Create R2 buckets
-   [ ] Create KV namespaces
-   [ ] Replace all Redis calls with Cloudflare storage clients
-   [ ] Create scraping consumer Worker
-   [ ] Set up scraping Queue
-   [ ] Rewrite scraping logic
-   [ ] Refactor agent logic into Agent classes
-   [ ] Configure Durable Object bindings
-   [ ] Replace agent state management
-   [ ] Create Vectorize index
-   [ ] Create embedding generation Worker
-   [ ] Implement RAG architecture
-   [ ] Write unit tests
-   [ ] Write end-to-end tests
