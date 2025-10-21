import { BaseAgentDO } from "./base-agent-do";
import type { AgentMessage, AgentResponse, AgentState } from "../types/agent-types";

export class ScrapingAgentDO extends BaseAgentDO {
        async handleMessage(message: AgentMessage): Promise<AgentResponse> {
                return {
                        type: "scraping_ack",
                        content: { received: message.content },
                        metadata: { timestamp: Date.now() },
                };
        }

        async getState(): Promise<AgentState> {
                const state = (await this.storage.get<AgentState>("scraping_state")) ?? null;
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
                                agentType: "scraping",
                                version: "1.0.0",
                                capabilities: ["web-scraping"],
                        },
                        createdAt: Date.now(),
                        lastUpdated: Date.now(),
                };
                await this.storage.put("scraping_state", initial);
                return initial;
        }

        async updateState(updates: Partial<AgentState>): Promise<void> {
                const current = await this.getState();
                const next: AgentState = {
                        ...current,
                        ...updates,
                        lastUpdated: Date.now(),
                };
                await this.storage.put("scraping_state", next);
        }
}
