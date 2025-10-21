import { BaseAgentDO } from "./base-agent-do";
import type { AgentMessage, AgentResponse, AgentState } from "../types/agent-types";

export class SessionManagerDO extends BaseAgentDO {
        async handleMessage(message: AgentMessage): Promise<AgentResponse> {
                if (message.type === "session_update") {
                        await this.updateState(message.content as Partial<AgentState>);
                        return { type: "session_updated", content: { ok: true } };
                }
                if (message.type === "session_get") {
                        const state = await this.getState();
                        return { type: "session_state", content: state };
                }
                return { type: "error", content: { message: "Unsupported session command" } };
        }

        async getState(): Promise<AgentState> {
                const state = (await this.storage.get<AgentState>("session_state")) ?? null;
                if (state) {
                                return state;
                }
                const initial: AgentState = {
                        agentId: crypto.randomUUID(),
                        sessionId: "",
                        conversationHistory: [],
                        extractedSlots: {},
                        preferences: {},
                        context: { sessionId: "", threadId: "" },
                        metadata: {
                                agentType: "meta",
                                version: "1.0.0",
                                capabilities: ["session-management"],
                        },
                        createdAt: Date.now(),
                        lastUpdated: Date.now(),
                };
                await this.storage.put("session_state", initial);
                return initial;
        }

        async updateState(updates: Partial<AgentState>): Promise<void> {
                const current = await this.getState();
                const next: AgentState = {
                        ...current,
                        ...updates,
                        lastUpdated: Date.now(),
                };
                await this.storage.put("session_state", next);
        }
}
