import type { WorkerEnv } from "../types/env";

export class AgentFactory {
        constructor(private readonly env: WorkerEnv) {}

        async createTravelAgent(sessionId: string): Promise<DurableObjectStub> {
                const id = this.env.TRAVEL_AGENT.idFromName(`travel:${sessionId}`);
                return this.env.TRAVEL_AGENT.get(id);
        }

        async createConversationManager(conversationId: string): Promise<DurableObjectStub> {
                const id = this.env.CONVERSATION_MANAGER.idFromName(`conversation:${conversationId}`);
                return this.env.CONVERSATION_MANAGER.get(id);
        }

        async createScrapingAgent(taskId: string): Promise<DurableObjectStub> {
                const id = this.env.SCRAPING_AGENT.idFromName(`scraping:${taskId}`);
                return this.env.SCRAPING_AGENT.get(id);
        }

        async getOrCreateSessionManager(userId: string): Promise<DurableObjectStub> {
                const id = this.env.SESSION_MANAGER.idFromName(`session:${userId}`);
                return this.env.SESSION_MANAGER.get(id);
        }
}
