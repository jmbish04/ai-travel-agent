import type { AgentState, AgentContext, AgentResponse, TravelIntent, ValidationResult } from "../types/agent-types";
import { createLogger } from "../utils/logger";

export abstract class TravelAgent {
        protected readonly log = createLogger();

        constructor(protected readonly storage: DurableObjectStorage, protected readonly env: Env) {}

        abstract readonly agentType: AgentState["metadata"]["agentType"];

        abstract handleIntent(intent: TravelIntent, context: AgentContext): Promise<AgentResponse>;

        abstract validateResponse(response: AgentResponse): Promise<ValidationResult>;

        async persistState(state: AgentState): Promise<void> {
                await this.storage.put("state", state);
        }

        async getState(): Promise<AgentState | null> {
                return (await this.storage.get<AgentState>("state")) ?? null;
        }

        async updateState(updates: Partial<AgentState>): Promise<AgentState> {
                const current = (await this.getState()) ?? (await this.initializeState());
                const merged: AgentState = {
                        ...current,
                        ...updates,
                        metadata: { ...current.metadata, ...updates.metadata },
                        context: { ...current.context, ...updates.context },
                        extractedSlots: { ...current.extractedSlots, ...updates.extractedSlots },
                        preferences: { ...current.preferences, ...updates.preferences },
                        lastUpdated: Date.now(),
                };
                await this.persistState(merged);
                return merged;
        }

        protected async initializeState(): Promise<AgentState> {
                const state: AgentState = {
                        agentId: crypto.randomUUID(),
                        sessionId: "", // will be populated when first update happens
                        conversationHistory: [],
                        extractedSlots: {},
                        preferences: {},
                        context: { sessionId: "", threadId: "" },
                        metadata: {
                                agentType: this.agentType,
                                version: "1.0.0",
                                capabilities: [],
                        },
                        createdAt: Date.now(),
                        lastUpdated: Date.now(),
                };
                await this.persistState(state);
                return state;
        }

        protected async appendConversationTurn(turn: AgentState["conversationHistory"][number]): Promise<void> {
                const state = (await this.getState()) ?? (await this.initializeState());
                state.conversationHistory = [...state.conversationHistory, turn].slice(-50);
                state.lastUpdated = Date.now();
                await this.persistState(state);
        }

        protected ensureSession(state: AgentState, context: AgentContext): AgentState {
                if (!state.sessionId) {
                        state.sessionId = context.sessionId;
                }
                state.context = { ...state.context, ...context };
                return state;
        }
}
