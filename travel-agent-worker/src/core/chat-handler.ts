import type { ChatInput, ChatOutput } from "../schemas/chat";
import type { SessionMessage, SessionStore } from "../types/session";
import type { WorkerEnv } from "../types/env";
import type { QueueService } from "./queue-service";
import type { ScrapingRequest } from "../types/queue-messages";
import type { Logger } from "../utils/logger";
import type { AgentResponse } from "../types/durable-object-types";
import { AgentFactory } from "./agent-factory";

interface ChatHandlerContext {
        env: WorkerEnv;
        log: Logger;
        ctx: ExecutionContext;
        sessionStore: SessionStore;
        queueService?: QueueService;
}

/**
 * Main chat handler - placeholder implementation
 * TODO: Migrate the actual chat logic from the original project
 */
export async function handleChat(input: ChatInput, context: ChatHandlerContext): Promise<ChatOutput> {
        const { sessionStore, log, queueService, env } = context;

        // Placeholder implementation
        // TODO: Integrate with Durable Objects for agent state
        // TODO: Integrate with D1 for data persistence
        // TODO: Integrate with Vectorize for semantic search

        log.info({ input }, "Processing chat request");

        let sessionId = input.sessionId;
        let session = sessionId ? await sessionStore.getSession(sessionId) : null;

        // Generate a thread ID if not provided, prefer persisted session thread
        const threadId = session?.threadId ?? input.threadId ?? crypto.randomUUID();

        if (!session) {
                sessionId = await sessionStore.createSession({
                        id: sessionId,
                        threadId,
                        userId: input.userId,
                        metadata: { receipts: input.receipts ?? false },
                });
                session = (await sessionStore.getSession(sessionId))!;
        } else {
                await sessionStore.touch(session.id);
        }

        if (queueService) {
                const scrapeRequests = identifyScrapeRequests(input.message, {
                        userId: input.userId,
                        sessionId: session.id,
                        threadId,
                });

                await Promise.all(
                        scrapeRequests.map(async (request) => {
                                try {
                                        await queueService.enqueueScrapeRequest(request);
                                } catch (error) {
                                        log.error({ error, request }, "Failed to enqueue scrape request");
                                }
                        }),
                );
        }

        const agentFactory = new AgentFactory(env);
        const conversationId = (session.metadata.conversationId as string | undefined) ?? session.id;
        const conversationManager = agentFactory.createConversationManager(conversationId);

        let conversationActive = Boolean(session.metadata.conversationActive);
        if (!conversationActive) {
                try {
                        await conversationManager.fetch(
                                new Request("https://agent/message", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                                type: "start_conversation",
                                                content: { conversationId },
                                                context: { userId: input.userId, sessionId: session.id, threadId },
                                        }),
                                }),
                        );
                        conversationActive = true;
                } catch (error) {
                        log.warn({ error }, "Failed to initialize conversation manager durable object");
                }
        }

        let agentResponse: AgentResponse | null = null;
        try {
                const routed = await conversationManager.fetch(
                        new Request("https://agent/message", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                        type: "route_message",
                                        content: { message: input.message, conversationId },
                                        context: { userId: input.userId, sessionId: session.id, threadId },
                                }),
                        }),
                );

                if (routed.ok) {
                        agentResponse = (await routed.json()) as AgentResponse;
                } else {
                        log.warn({ status: routed.status }, "Conversation manager returned non-OK status");
                }
        } catch (error) {
                log.error({ error }, "Failed to route message to conversation manager");
        }

        const fallbackReply = `Hello! You said: "${input.message}". This is a placeholder response from Cloudflare Workers.`;
        const serializedResponseContent =
                agentResponse && typeof agentResponse.content !== "string"
                        ? JSON.stringify(agentResponse.content)
                        : undefined;
        const reply =
                typeof agentResponse?.content === "string"
                        ? agentResponse.content
                        : serializedResponseContent ?? fallbackReply;

        const now = Date.now();
        const userMessage: SessionMessage = {
                id: crypto.randomUUID(),
                role: "user",
                content: input.message,
                timestamp: now,
                metadata: {
                        conversationId,
                        routedThroughAgent: true,
                },
        };

        const assistantMessage: SessionMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                content: reply,
                timestamp: Date.now(),
                metadata: {
                        conversationId,
                        agentResponse,
                },
        };

        await sessionStore.appendMessages(session.id, [userMessage, assistantMessage]);
        await sessionStore.updateSession(session.id, {
                threadId,
                lastAccessedAt: Date.now(),
                metadata: {
                        ...session.metadata,
                        conversationId,
                        conversationActive,
                        lastAgentType:
                                (agentResponse?.metadata?.targetAgent as string | undefined) ??
                                (agentResponse?.type ?? "travel"),
                        lastReplyPreview: reply.slice(0, 160),
                },
        });

        return {
                reply,
                threadId,
                sessionId: session.id,
        };
}

const URL_PATTERN = /(https?:\/\/[^\s]+)/gi;

function identifyScrapeRequests(
        message: string,
        context: { userId?: string; sessionId: string; threadId: string },
): ScrapingRequest[] {
        const matches = message.match(URL_PATTERN) ?? [];

        return matches.map((url) => {
                const normalized = url.replace(/[).,]+$/, "");
                return {
                        url: normalized,
                        scrapeType: inferScrapeType(normalized),
                        options: {},
                        context,
                        metadata: {
                                priority: message.toLowerCase().includes("urgent") ? "urgent" : "normal",
                                scheduledAt: Date.now(),
                                maxRetries: 3,
                                timeoutMs: 30_000,
                                correlationId: crypto.randomUUID(),
                                userId: context.userId,
                                sessionId: context.sessionId,
                        },
                } satisfies ScrapingRequest;
        });
}

function inferScrapeType(url: string): ScrapingRequest["scrapeType"] {
        const normalized = url.toLowerCase();
        if (normalized.includes("flight") || normalized.includes("airlines")) {
                return "flight";
        }
        if (normalized.includes("hotel") || normalized.includes("stay") || normalized.includes("booking")) {
                return "hotel";
        }
        if (normalized.includes("tour") || normalized.includes("attraction")) {
                return "attraction";
        }
        return "general";
}
