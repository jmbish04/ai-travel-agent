import { BaseAgentDO } from "./base-agent-do";
import type { AgentMessage, AgentResponse, AgentState } from "../types/agent-types";

export class TravelAgentDO extends BaseAgentDO {
        async handleMessage(message: AgentMessage): Promise<AgentResponse> {
                const context = this.buildAgentContext(message);
                const agent = this.createMetaAgent();
                return agent.handleIntent(message.content as any, context);
        }

        async getState(): Promise<AgentState> {
                const state = (await this.storage.get<AgentState>("state")) ?? null;
                if (state) {
                        return state;
                }
                const agent = this.createMetaAgent();
                return (await agent.getState()) ?? (await agent.updateState({}));
        }

        async updateState(updates: Partial<AgentState>): Promise<void> {
                const agent = this.createMetaAgent();
                await agent.updateState(updates);
        }
}
