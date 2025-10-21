import type { ChatInput, ChatOutput } from "../schemas/chat";
import type { SessionMessage, SessionStore } from "../types/session";
import type { WorkerEnv } from "../types/env";
import type { QueueService } from "./queue-service";
import type { ScrapingRequest } from "../types/queue-messages";
import type { Logger } from "../utils/logger";
import type { AgentResponse } from "../types/agent-types";
import { AgentFactory } from "./agent-factory";

interface ChatHandlerContext {
        env: WorkerEnv;
        log: Logger;
        ctx: ExecutionContext;
        sessionStore: SessionStore;
        queueService?: QueueService;
        agentFactory?: AgentFactory;
}

/**
 * Main chat handler - placeholder implementation
 * TODO: Migrate the actual chat logic from the original project
 */
export async function handleChat(input: ChatInput, context: ChatHandlerContext): Promise<ChatOutput> {
        const { sessionStore, log, queueService, agentFactory } = context;

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

        let reply = `Hello! You said: "${input.message}". This is a placeholder response from Cloudflare Workers.`;
        let orchestratedResponse: AgentResponse | null = null;

        if (agentFactory) {
                try {
                        const conversationManager = await agentFactory.createConversationManager(session.id);
                        await conversationManager.fetch("https://agent/message", {
                                method: "POST",
                                body: JSON.stringify({
                                        type: "start_conversation",
                                        content: {},
                                        context: {
                                                sessionId: session.id,
                                                threadId,
                                                userId: input.userId,
                                                locale: input.locale,
                                                timezone: input.timezone,
                                        },
                                }),
                        });

                        const routed = await conversationManager.fetch("https://agent/message", {
                                method: "POST",
                                body: JSON.stringify({
                                        type: "route_message",
                                        content: { message: input.message },
                                        context: {
                                                sessionId: session.id,
                                                threadId,
                                                userId: input.userId,
                                                locale: input.locale,
                                                timezone: input.timezone,
                                        },
                                }),
                        });

                        if (routed.ok) {
                                orchestratedResponse = (await routed.json()) as AgentResponse;
                                const content = orchestratedResponse.content;
                                if (typeof content === "string") {
                                        reply = content;
                                } else if (content && typeof content === "object") {
                                        reply = JSON.stringify(content);
                                }
                        } else {
                                log.warn({ status: routed.status }, "Conversation manager response not ok");
                        }
                } catch (error) {
                        log.error({ error }, "Agent orchestration failed, falling back to echo");
                }
        }

        const now = Date.now();
        const userMessage: SessionMessage = {
                id: crypto.randomUUID(),
                role: "user",
                content: input.message,
                timestamp: now,
        };

        const assistantMessage: SessionMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                content: reply,
                timestamp: Date.now(),
                metadata: orchestratedResponse
                        ? {
                                  agentType: orchestratedResponse.metadata?.intent?.type,
                                  toolsUsed: orchestratedResponse.metadata?.toolsUsed,
                                  confidence: orchestratedResponse.confidence,
                          }
                        : undefined,
        };

        await sessionStore.appendMessages(session.id, [userMessage, assistantMessage]);
        await sessionStore.updateSession(session.id, {
                threadId,
                lastAccessedAt: Date.now(),
                metadata: {
                        ...session.metadata,
                        lastReplyPreview: reply.slice(0, 160),
                },
        });

        return {
                reply,
                threadId,
                sessionId: session.id,
                metadata: orchestratedResponse
                        ? {
                                  confidence: orchestratedResponse.confidence,
                                  sources: orchestratedResponse.sources,
                                  intent: orchestratedResponse.metadata?.intent,
                          }
                        : undefined,
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
