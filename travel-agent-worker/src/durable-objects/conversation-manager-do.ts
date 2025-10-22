import { BaseAgentDO } from "./base-agent-do";
import type {
        AgentContext,
        AgentMessage,
        AgentResponse,
        AgentState,
        ConversationDescriptor,
} from "../types/durable-object-types";
import type { WorkerEnv } from "../types/env";
import { createAgentResponse } from "../utils/do-helpers";

interface RouteMessageContent {
        message: unknown;
        targetAgent?: string;
        conversationId?: string;
}

interface CoordinateAgentsContent {
        agents?: string[];
        conversationId?: string;
}

export class ConversationManagerDO extends BaseAgentDO {
        private readonly activeAgents = new Map<string, DurableObjectStub>();

        constructor(state: DurableObjectState, env: WorkerEnv) {
                super(state, env);
        }

        protected override createInitialState(): AgentState {
                const base = super.createInitialState();
                return {
                        ...base,
                        context: { ...base.context, agentType: "conversation_manager" },
                        cache: { conversations: {} },
                };
        }

        protected async handleMessage(message: AgentMessage): Promise<AgentResponse> {
                const context = message.context ?? {};
                switch (message.type) {
                        case "start_conversation":
                                return this.startConversation(message.content, context);
                        case "route_message":
                                return this.routeMessage(message.content, context);
                        case "coordinate_agents":
                                return this.coordinateAgents(message.content, context);
                        default:
                                return createAgentResponse({
                                        type: "error",
                                        status: "error",
                                        content: null,
                                        error: `Unsupported message type: ${message.type}`,
                                });
                }
        }

        private async startConversation(content: unknown, context: AgentContext): Promise<AgentResponse> {
                const payload = (content as Record<string, unknown>) ?? {};
                const conversationId =
                        (typeof payload.conversationId === "string" && payload.conversationId) ||
                        context.conversationId ||
                        crypto.randomUUID();

                const descriptor = await this.ensureConversation(conversationId, context.userId);
                descriptor.participants = Array.from(new Set([...descriptor.participants, "travel"]));
                descriptor.lastActiveAt = Date.now();
                descriptor.metadata = { ...descriptor.metadata, context, payload };
                await this.saveConversation(descriptor);

                await this.ensureAgentStub("travel", conversationId);

                await this.addToConversationHistory({
                        id: crypto.randomUUID(),
                        role: "system",
                        payloadType: "message",
                        payload: {
                                id: crypto.randomUUID(),
                                type: "conversation_started",
                                content: { conversationId, context },
                        },
                        timestamp: Date.now(),
                });

                return createAgentResponse({
                        type: "conversation_started",
                        content: {
                                conversationId,
                                activeAgents: descriptor.participants,
                        },
                        metadata: { context },
                });
        }

        private async routeMessage(content: unknown, context: AgentContext): Promise<AgentResponse> {
                const payload = (content as RouteMessageContent) ?? {};
                const conversationId =
                        payload.conversationId ||
                        context.conversationId ||
                        context.sessionId ||
                        crypto.randomUUID();
                const descriptor = await this.ensureConversation(conversationId, context.userId);

                const targetAgent = payload.targetAgent ?? "travel";
                const agentStub = await this.ensureAgentStub(targetAgent, conversationId);

                descriptor.participants = Array.from(new Set([...descriptor.participants, targetAgent]));
                descriptor.lastActiveAt = Date.now();
                await this.saveConversation(descriptor);

                const agentMessage: AgentMessage = {
                        id: crypto.randomUUID(),
                        type: "chat",
                        content: payload.message,
                        context: { ...context, conversationId },
                };

                await this.addToConversationHistory({
                        id: agentMessage.id!,
                        role: "user",
                        payloadType: "message",
                        payload: agentMessage,
                        timestamp: Date.now(),
                        metadata: { targetAgent },
                });

                const response = await agentStub.fetch(
                        new Request("https://agent/message", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(agentMessage),
                        }),
                );

                const agentResponse = (await response.json()) as AgentResponse;

                await this.addToConversationHistory({
                        id: agentResponse.id ?? crypto.randomUUID(),
                        role: "assistant",
                        payloadType: "response",
                        payload: agentResponse,
                        timestamp: Date.now(),
                        metadata: { targetAgent },
                });

                return agentResponse;
        }

        private async coordinateAgents(content: unknown, context: AgentContext): Promise<AgentResponse> {
                const payload = (content as CoordinateAgentsContent) ?? {};
                const conversationId =
                        payload.conversationId ||
                        context.conversationId ||
                        context.sessionId ||
                        crypto.randomUUID();
                const descriptor = await this.ensureConversation(conversationId, context.userId);

                const agents = payload.agents ?? descriptor.participants;
                const results = await Promise.all(
                        agents.map(async (agentType) => {
                                try {
                                        const stub = await this.ensureAgentStub(agentType, conversationId);
                                        const response = await stub.fetch("https://agent/state");
                                        const state = (await response.json()) as AgentState;
                                        return { agentType, success: true, state };
                                } catch (error) {
                                        const message = error instanceof Error ? error.message : String(error);
                                        return { agentType, success: false, error: message };
                                }
                        }),
                );

                return createAgentResponse({
                        type: "agent_states",
                        content: {
                                conversationId,
                                results,
                        },
                        metadata: { context },
                });
        }

        private async ensureAgentStub(agentType: string, conversationId: string): Promise<DurableObjectStub> {
                const key = this.agentKey(agentType, conversationId);
                const existing = this.activeAgents.get(key);
                if (existing) {
                        return existing;
                }

                let stub: DurableObjectStub;
                switch (agentType) {
                        case "travel":
                                stub = this.env.TRAVEL_AGENT.get(
                                        this.env.TRAVEL_AGENT.idFromName(`${agentType}:${conversationId}`),
                                );
                                break;
                        case "scraping":
                                stub = this.env.SCRAPING_AGENT.get(
                                        this.env.SCRAPING_AGENT.idFromName(`${agentType}:${conversationId}`),
                                );
                                break;
                        case "session":
                                stub = this.env.SESSION_MANAGER.get(
                                        this.env.SESSION_MANAGER.idFromName(`${agentType}:${conversationId}`),
                                );
                                break;
                        default:
                                throw new Error(`Unknown agent type: ${agentType}`);
                }

                this.activeAgents.set(key, stub);
                return stub;
        }

        private agentKey(agentType: string, conversationId: string): string {
                return `${agentType}:${conversationId}`;
        }

        private conversationStorageKey(conversationId: string): string {
                return `conversation:${conversationId}`;
        }

        private async ensureConversation(conversationId: string, userId?: string): Promise<ConversationDescriptor> {
                const key = this.conversationStorageKey(conversationId);
                const existing = await this.storage.get<ConversationDescriptor>(key);
                if (existing) {
                                return existing;
                }

                const descriptor: ConversationDescriptor = {
                        id: conversationId,
                        userId,
                        startedAt: Date.now(),
                        lastActiveAt: Date.now(),
                        participants: [],
                        metadata: {},
                };

                await this.storage.put(key, descriptor);
                return descriptor;
        }

        private async saveConversation(descriptor: ConversationDescriptor): Promise<void> {
                const key = this.conversationStorageKey(descriptor.id);
                await this.storage.put(key, descriptor);
        }
}
