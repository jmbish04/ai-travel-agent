import type { AgentState, ConversationTurn } from "../types/agent-types";

export class AgentStateManager {
        constructor(private readonly storage: DurableObjectStorage) {}

        async saveState(state: AgentState): Promise<void> {
                await this.storage.put("agent_state", state);
                await this.storage.put("last_updated", Date.now());
        }

        async getState(): Promise<AgentState | null> {
                return (await this.storage.get<AgentState>("agent_state")) ?? null;
        }

        async appendConversationTurn(turn: ConversationTurn): Promise<void> {
                const state = (await this.getState()) ?? null;
                if (!state) {
                        return;
                }
                const history = [...state.conversationHistory, turn].slice(-100);
                await this.saveState({ ...state, conversationHistory: history });
        }

        async updateSlots(slots: Record<string, unknown>): Promise<void> {
                const state = (await this.getState()) ?? null;
                if (!state) {
                        return;
                }
                await this.saveState({
                        ...state,
                        extractedSlots: { ...state.extractedSlots, ...slots },
                });
        }
}
