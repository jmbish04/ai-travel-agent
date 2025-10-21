import { TravelAgent } from "./base-agent";
import type {
        AgentContext,
        AgentResponse,
        DestinationIntent,
        TravelIntent,
        ValidationResult,
} from "../types/agent-types";
import type { AgentToolResult } from "../tools/agent-tool-registry";
import { AgentToolRegistry } from "../tools/agent-tool-registry";

export class DestinationAgent extends TravelAgent {
        readonly agentType = "destination" as const;
        private readonly tools: AgentToolRegistry;

        constructor(storage: DurableObjectStorage, env: Env, tools: AgentToolRegistry) {
                super(storage, env);
                this.tools = tools;
        }

        async handleIntent(intent: TravelIntent, context: AgentContext): Promise<AgentResponse> {
                const destinationIntent = intent as DestinationIntent;
                const toolResults: AgentToolResult[] = [];

                if (destinationIntent.query) {
                        toolResults.push(
                                await this.tools.executeTool(
                                        "search",
                                        { query: destinationIntent.query, locale: context.locale },
                                        context,
                                ),
                        );
                }

                if (destinationIntent.preferences?.interests) {
                        toolResults.push(
                                await this.tools.executeTool(
                                        "attractions",
                                        {
                                                destination: destinationIntent.query,
                                                interests: destinationIntent.preferences.interests as string[],
                                        },
                                        context,
                                ),
                        );
                }

                const response: AgentResponse = {
                        type: "chat_response",
                        content: {
                                destinations: this.rankDestinations(toolResults),
                                searchMetadata: {
                                        query: destinationIntent.query,
                                        resultsCount: toolResults.length,
                                },
                        },
                        confidence: toolResults.length > 0 ? 0.7 : 0.3,
                        metadata: {
                                intent,
                                toolsUsed: toolResults.map((tool) => tool.name),
                                timestamp: Date.now(),
                        },
                };

                await this.appendConversationTurn({
                        id: crypto.randomUUID(),
                        timestamp: Date.now(),
                        userMessage: destinationIntent.raw?.toString() ?? destinationIntent.query,
                        agentResponse: response,
                        intent,
                        toolResults,
                });

                return response;
        }

        async validateResponse(response: AgentResponse): Promise<ValidationResult> {
                const issues: string[] = [];
                if (!response.content) {
                        issues.push("Missing destination content");
                }
                return { ok: issues.length === 0, issues, response };
        }

        private rankDestinations(toolResults: AgentToolResult[]): unknown {
                return toolResults
                        .filter((result) => result.success)
                        .map((result) => ({
                                source: result.name,
                                data: result.data,
                        }));
        }
}
