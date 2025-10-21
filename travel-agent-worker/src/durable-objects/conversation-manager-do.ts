import { BaseAgentDO } from "./base-agent-do";
import type { AgentMessage, AgentResponse, AgentState } from "../types/agent-types";
import { createLogger } from "../utils/logger";

interface ConversationState extends AgentState {
        activeAgents: string[];
}

export class ConversationManagerDO extends BaseAgentDO {
        private readonly log = createLogger();

        async handleMessage(message: AgentMessage): Promise<AgentResponse> {
                if (message.type === "route_message") {
                        return this.routeMessage(message);
                }
                if (message.type === "start_conversation") {
                        return this.startConversation(message);
                }
                return { type: "error", content: { message: "Unsupported message" } };
        }

        async getState(): Promise<AgentState> {
                const state = (await this.storage.get<ConversationState>("conversation_state")) ?? null;
                if (state) {
                        return state;
                }
                const initial: ConversationState = {
                        agentId: crypto.randomUUID(),
                        sessionId: "",
                        conversationHistory: [],
                        extractedSlots: {},
                        preferences: {},
                        context: { sessionId: "", threadId: "" },
                        metadata: {
                                agentType: "meta",
                                version: "1.0.0",
                                capabilities: [],
                        },
                        createdAt: Date.now(),
                        lastUpdated: Date.now(),
                        activeAgents: [],
                };
                await this.storage.put("conversation_state", initial);
                return initial;
        }

        async updateState(updates: Partial<AgentState>): Promise<void> {
                const current = (await this.getState()) as ConversationState;
                const next: ConversationState = {
                        ...current,
                        ...updates,
                        lastUpdated: Date.now(),
                        activeAgents: (updates as ConversationState).activeAgents ?? current.activeAgents,
                };
                await this.storage.put("conversation_state", next);
        }

        private async startConversation(message: AgentMessage): Promise<AgentResponse> {
                const context = this.buildAgentContext(message);
                const conversationId = context.sessionId || crypto.randomUUID();
                await this.updateState({
                        sessionId: conversationId,
                        context,
                        metadata: {
                                agentType: "meta",
                                version: "1.0.0",
                                capabilities: ["routing"],
                        },
                });
                return {
                        type: "conversation_started",
                        content: { conversationId, activeAgents: ["travel"] },
                        metadata: { timestamp: Date.now() },
                } satisfies AgentResponse;
        }

        private async routeMessage(message: AgentMessage): Promise<AgentResponse> {
                const context = this.buildAgentContext(message);
                const target = message.metadata?.targetAgent ?? "travel";
                this.log.info({ target }, "Routing message to travel agent");

                const travelIntent = this.normalizeToIntent(message.content);

                const travelAgentStub = this.env.TRAVEL_AGENT.get(
                        this.env.TRAVEL_AGENT.idFromName(`${target}:${context.sessionId}`),
                );
                const response = await travelAgentStub.fetch("https://agent/message", {
                        method: "POST",
                        body: JSON.stringify({
                                type: "chat",
                                content: travelIntent,
                                context,
                        }),
                });
                return (await response.json()) as AgentResponse;
        }

        private normalizeToIntent(raw: unknown): unknown {
                if (raw && typeof raw === "object" && "type" in (raw as Record<string, unknown>)) {
                        return raw;
                }

                const message =
                        typeof raw === "string"
                                ? raw
                                : typeof raw === "object" && raw && "message" in raw
                                        ? String((raw as Record<string, unknown>).message)
                                        : JSON.stringify(raw);

                return {
                        type: "destination",
                        query: message,
                        raw: message,
                };
        }
}
