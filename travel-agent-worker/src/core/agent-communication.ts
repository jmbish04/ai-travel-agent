import type { AgentMessage } from "../types/agent-types";
import type { DurableObjectStub } from "../types/durable-object-types";

export class AgentCommunicationHub {
        constructor(private readonly env: Env) {}

        async sendMessage(fromAgent: string, toAgent: DurableObjectStub, message: AgentMessage): Promise<void> {
                await toAgent.fetch("https://agent/message", {
                        method: "POST",
                        body: JSON.stringify({ ...message, metadata: { ...(message.metadata ?? {}), fromAgent } }),
                });
        }

        async broadcastMessage(fromAgent: string, agents: DurableObjectStub[], message: AgentMessage): Promise<void> {
                await Promise.all(agents.map((agent) => this.sendMessage(fromAgent, agent, message)));
        }
}
