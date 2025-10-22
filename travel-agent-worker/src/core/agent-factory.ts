import type { WorkerEnv } from "../types/env";

export class AgentFactory {
        constructor(private readonly env: WorkerEnv) {}

        createTravelAgent(sessionId: string): DurableObjectStub {
                const id = this.env.TRAVEL_AGENT.idFromName(`travel:${sessionId}`);
                return this.env.TRAVEL_AGENT.get(id);
        }

        createConversationManager(conversationId: string): DurableObjectStub {
                const id = this.env.CONVERSATION_MANAGER.idFromName(`conversation:${conversationId}`);
                return this.env.CONVERSATION_MANAGER.get(id);
        }

        createScrapingAgent(taskId: string): DurableObjectStub {
                const id = this.env.SCRAPING_AGENT.idFromName(`scraping:${taskId}`);
                return this.env.SCRAPING_AGENT.get(id);
        }

        createSessionManager(userId: string): DurableObjectStub {
                const id = this.env.SESSION_MANAGER.idFromName(`session:${userId}`);
                return this.env.SESSION_MANAGER.get(id);
        }
}
