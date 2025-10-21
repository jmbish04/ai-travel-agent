import { TravelAgent } from "./base-agent";
import type {
        AgentContext,
        AgentResponse,
        BookingIntent,
        TravelIntent,
        ValidationResult,
} from "../types/agent-types";
import type { AgentToolResult } from "../tools/agent-tool-registry";
import { AgentToolRegistry } from "../tools/agent-tool-registry";

export class BookingAgent extends TravelAgent {
        readonly agentType = "booking" as const;
        private readonly tools: AgentToolRegistry;

        constructor(storage: DurableObjectStorage, env: Env, tools: AgentToolRegistry) {
                super(storage, env);
                this.tools = tools;
        }

        async handleIntent(intent: TravelIntent, context: AgentContext): Promise<AgentResponse> {
                const bookingIntent = intent as BookingIntent;
                const toolResults: AgentToolResult[] = [];

                if (bookingIntent.bookingType === "flight") {
                                toolResults.push(
                                        await this.tools.executeTool("flights", bookingIntent.criteria, context),
                                );
                } else if (bookingIntent.bookingType === "hotel") {
                                toolResults.push(
                                        await this.tools.executeTool("hotels", bookingIntent.criteria, context),
                                );
                }

                const response: AgentResponse = {
                        type: "chat_response",
                        content: {
                                bookingType: bookingIntent.bookingType,
                                options: toolResults.map((result) => result.data),
                        },
                        confidence: toolResults.every((tool) => tool.success) ? 0.75 : 0.35,
                        metadata: {
                                intent,
                                toolsUsed: toolResults.map((tool) => tool.name),
                                timestamp: Date.now(),
                        },
                };

                await this.appendConversationTurn({
                        id: crypto.randomUUID(),
                        timestamp: Date.now(),
                        userMessage: bookingIntent.raw?.toString() ?? bookingIntent.bookingType,
                        agentResponse: response,
                        intent,
                        toolResults,
                });

                return response;
        }

        async validateResponse(response: AgentResponse): Promise<ValidationResult> {
                const issues: string[] = [];
                if (!Array.isArray((response.content as { options?: unknown[] }).options)) {
                        issues.push("Missing booking options");
                }
                return { ok: issues.length === 0, issues, response };
        }
}
