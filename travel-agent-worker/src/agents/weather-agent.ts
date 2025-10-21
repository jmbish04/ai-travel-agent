import { TravelAgent } from "./base-agent";
import type {
        AgentContext,
        AgentResponse,
        TravelIntent,
        ValidationResult,
        WeatherIntent,
} from "../types/agent-types";
import type { AgentToolResult } from "../tools/agent-tool-registry";
import { AgentToolRegistry } from "../tools/agent-tool-registry";

export class WeatherAgent extends TravelAgent {
        readonly agentType = "weather" as const;
        private readonly tools: AgentToolRegistry;

        constructor(storage: DurableObjectStorage, env: Env, tools: AgentToolRegistry) {
                super(storage, env);
                this.tools = tools;
        }

        async handleIntent(intent: TravelIntent, context: AgentContext): Promise<AgentResponse> {
                const weatherIntent = intent as WeatherIntent;
                const state = await this.updateState({ currentIntent: intent, context });

                const toolResults: AgentToolResult[] = [];
                if (weatherIntent.destination) {
                        const result = await this.tools.executeTool(
                                "weather",
                                {
                                        destination: weatherIntent.destination,
                                        dates: weatherIntent.dates,
                                },
                                context,
                        );
                        toolResults.push(result);
                }

                const response: AgentResponse = {
                        type: "chat_response",
                        content: {
                                weather: toolResults.at(0)?.data ?? null,
                                analysis: this.analyzeWeather(toolResults.at(0)?.data),
                        },
                        confidence: toolResults.every((tool) => tool.success) ? 0.8 : 0.4,
                        metadata: {
                                intent,
                                toolsUsed: toolResults.map((tool) => tool.name),
                                timestamp: Date.now(),
                        },
                };

                await this.appendConversationTurn({
                        id: crypto.randomUUID(),
                        timestamp: Date.now(),
                        userMessage: weatherIntent.raw?.toString() ?? "",
                        agentResponse: response,
                        intent,
                        toolResults,
                });

                await this.persistState({
                        ...state,
                        lastUpdated: Date.now(),
                        currentIntent: intent,
                });

                return response;
        }

        async validateResponse(response: AgentResponse): Promise<ValidationResult> {
                const issues: string[] = [];
                if (!response.content) {
                        issues.push("Missing weather content");
                }
                return { ok: issues.length === 0, issues, response };
        }

        private analyzeWeather(data: unknown): Record<string, unknown> {
                if (!data || typeof data !== "object") {
                        return { suitability: "unknown" };
                }
                return {
                        suitability: "good",
                        packingRecommendations: ["Light jacket", "Comfortable shoes"],
                        activityRecommendations: ["City walking tour", "Outdoor cafe"],
                        raw: data,
                };
        }
}
