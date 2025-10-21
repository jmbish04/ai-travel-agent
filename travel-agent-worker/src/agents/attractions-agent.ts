import { TravelAgent } from "./base-agent";
import type {
        AgentContext,
        AgentResponse,
        AttractionsIntent,
        TravelIntent,
        ValidationResult,
} from "../types/agent-types";
import { AgentToolRegistry } from "../tools/agent-tool-registry";

export class AttractionsAgent extends TravelAgent {
        readonly agentType = "attractions" as const;
        private readonly tools: AgentToolRegistry;

        constructor(storage: DurableObjectStorage, env: Env, tools: AgentToolRegistry) {
                super(storage, env);
                this.tools = tools;
        }

        async handleIntent(intent: TravelIntent, context: AgentContext): Promise<AgentResponse> {
                const attractionsIntent = intent as AttractionsIntent;
                const result = await this.tools.executeTool(
                        "attractions",
                        {
                                destination: attractionsIntent.destination,
                                interests: attractionsIntent.interests,
                        },
                        context,
                );

                return {
                        type: "chat_response",
                        content: result.data,
                        confidence: result.success ? 0.65 : 0.25,
                        metadata: {
                                intent,
                                toolsUsed: [result.name],
                                timestamp: Date.now(),
                        },
                } satisfies AgentResponse;
        }

        async validateResponse(response: AgentResponse): Promise<ValidationResult> {
                const ok = Boolean(response.content);
                return { ok, issues: ok ? [] : ["Missing attractions content"], response };
        }
}
