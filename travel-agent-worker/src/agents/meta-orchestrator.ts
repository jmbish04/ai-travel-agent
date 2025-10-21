import { TravelAgent } from "./base-agent";
import type {
        AgentContext,
        AgentResponse,
        RoutingDecision,
        TravelIntent,
        ValidationResult,
} from "../types/agent-types";
import { WeatherAgent } from "./weather-agent";
import { DestinationAgent } from "./destination-agent";
import { BookingAgent } from "./booking-agent";
import { AttractionsAgent } from "./attractions-agent";
import { AgentToolRegistry } from "../tools/agent-tool-registry";

export class MetaOrchestratorAgent extends TravelAgent {
        readonly agentType = "meta" as const;
        private readonly weatherAgent: WeatherAgent;
        private readonly destinationAgent: DestinationAgent;
        private readonly bookingAgent: BookingAgent;
        private readonly attractionsAgent: AttractionsAgent;

        constructor(storage: DurableObjectStorage, env: Env, tools: AgentToolRegistry) {
                super(storage, env);
                this.weatherAgent = new WeatherAgent(storage, env, tools);
                this.destinationAgent = new DestinationAgent(storage, env, tools);
                this.bookingAgent = new BookingAgent(storage, env, tools);
                this.attractionsAgent = new AttractionsAgent(storage, env, tools);
        }

        async handleIntent(intent: TravelIntent, context: AgentContext): Promise<AgentResponse> {
                const routing = await this.routeIntent(intent);
                const primaryAgent = this.getAgent(routing.primaryAgent);
                const primaryResponse = await primaryAgent.handleIntent(intent, context);

                const additionalResponses = await Promise.all(
                        routing.additionalAgents.map(async (agentType) => {
                                const agent = this.getAgent(agentType);
                                return agent.handleIntent(intent, context);
                        }),
                );

                return this.blendResponses(primaryResponse, additionalResponses);
        }

        async validateResponse(response: AgentResponse): Promise<ValidationResult> {
                const issues: string[] = [];
                if (!response.content) {
                        issues.push("Missing orchestrated content");
                }
                return { ok: issues.length === 0, issues, response };
        }

        private async routeIntent(intent: TravelIntent): Promise<RoutingDecision> {
                const type = intent.type ?? "destination";
                const additionalAgents: RoutingDecision["additionalAgents"] = [];

                if (type === "destination" || type === "attractions") {
                        additionalAgents.push("weather");
                } else if (type === "booking") {
                        additionalAgents.push("destination");
                }

                return {
                        primaryAgent: type,
                        additionalAgents,
                        confidence: intent.confidence ?? 0.6,
                } satisfies RoutingDecision;
        }

        private getAgent(type: TravelIntent["type"]): TravelAgent {
                switch (type) {
                        case "weather":
                                return this.weatherAgent;
                        case "booking":
                                return this.bookingAgent;
                        case "attractions":
                                return this.attractionsAgent;
                        case "destination":
                        default:
                                return this.destinationAgent;
                }
        }

        private blendResponses(
                primary: AgentResponse,
                additional: AgentResponse[],
        ): AgentResponse<Record<string, unknown>> {
                const sources = [primary, ...additional];
                const content = Object.fromEntries(
                        sources.flatMap((response, index) => {
                                const key = index === 0 ? "primary" : `additional_${index}`;
                                return [[key, response.content]];
                        }),
                );

                return {
                        type: "chat_response",
                        content,
                        confidence:
                                sources.reduce((sum, response) => sum + (response.confidence ?? 0), 0) /
                                Math.max(1, sources.length),
                        metadata: {
                                intent: primary.metadata?.intent,
                                toolsUsed: sources.flatMap((response) => response.metadata?.toolsUsed ?? []),
                                timestamp: Date.now(),
                        },
                } satisfies AgentResponse<Record<string, unknown>>;
        }
}
