import { BaseAgentDO } from "./base-agent-do";
import type {
        AgentContext,
        AgentMessage,
        AgentResponse,
        AgentState,
        ToolCall,
        ToolResult,
} from "../types/durable-object-types";
import type { WorkerEnv } from "../types/env";
import { AgentToolRegistry, createAgentResponse } from "../utils/do-helpers";

interface TravelIntent {
        goal: string;
        slots: Record<string, unknown>;
        confidence: number;
}

export class TravelAgentDO extends BaseAgentDO {
        private readonly tools: AgentToolRegistry;

        constructor(state: DurableObjectState, env: WorkerEnv) {
                super(state, env);
                this.tools = new AgentToolRegistry(env);
                this.registerDefaultTools();
        }

        protected override createInitialState(): AgentState {
                const base = super.createInitialState();
                return {
                        ...base,
                        context: { ...base.context, agentType: "travel" },
                };
        }

        protected async handleMessage(message: AgentMessage): Promise<AgentResponse> {
                const context = message.context ?? {};
                switch (message.type) {
                        case "chat":
                                return this.handleChatMessage(message.content, context);
                        case "tool_call":
                                return this.handleToolInvocation(message.content);
                        case "state_query":
                                return createAgentResponse({
                                        type: "state_snapshot",
                                        content: await this.getState(),
                                        metadata: { context },
                                });
                        default:
                                return createAgentResponse({
                                        type: "error",
                                        status: "error",
                                        content: null,
                                        error: `Unsupported message type: ${message.type}`,
                                        metadata: { context },
                                });
                }
        }

        private async handleChatMessage(content: unknown, context: AgentContext): Promise<AgentResponse> {
                const text = typeof content === "string" ? content : JSON.stringify(content);
                const timestamp = Date.now();

                const incoming: AgentMessage = {
                        id: crypto.randomUUID(),
                        type: "chat",
                        content: text,
                        context,
                };

                await this.addToConversationHistory({
                        id: incoming.id!,
                        role: "user",
                        payloadType: "message",
                        payload: incoming,
                        timestamp,
                });

                const intent = this.extractIntent(text, context);
                const itinerarySuggestions = this.buildItinerarySuggestions(intent);
                const responseText = this.composeResponse(text, intent, itinerarySuggestions);

                const response = createAgentResponse({
                        type: "chat_response",
                        content: responseText,
                        confidence: intent.confidence,
                        metadata: {
                                intent,
                                suggestions: itinerarySuggestions,
                                context,
                        },
                });

                await this.addToConversationHistory({
                        id: response.id!,
                        role: "assistant",
                        payloadType: "response",
                        payload: response,
                        timestamp: Date.now(),
                });

                const state = await this.getState();
                await this.updateState({
                        extractedSlots: { ...state.extractedSlots, ...intent.slots },
                        context: { ...state.context, ...context },
                });

                return response;
        }

        private async handleToolInvocation(content: unknown): Promise<AgentResponse> {
                const call = content as ToolCall | null;
                if (!call || typeof call.name !== "string") {
                        return createAgentResponse({
                                type: "tool_result",
                                status: "error",
                                content: null,
                                error: "Invalid tool call payload",
                        });
                }

                const toolCall: ToolCall = {
                        name: call.name,
                        parameters: call.parameters ?? {},
                        metadata: call.metadata,
                };

                const start = Date.now();
                try {
                        const result = await this.tools.executeTool(toolCall.name, toolCall.parameters ?? {});
                        const durationMs = Date.now() - start;

                        const toolResult: ToolResult = {
                                toolCall,
                                success: true,
                                data: result,
                                durationMs,
                        };

                        await this.addToConversationHistory({
                                id: crypto.randomUUID(),
                                role: "tool",
                                payloadType: "response",
                                payload: createAgentResponse({
                                        type: "tool_result",
                                        content: toolResult,
                                }),
                                timestamp: Date.now(),
                        });

                        return createAgentResponse({
                                type: "tool_result",
                                content: toolResult,
                        });
                } catch (error) {
                        const durationMs = Date.now() - start;
                        const message = error instanceof Error ? error.message : String(error);

                        const toolResult: ToolResult = {
                                toolCall,
                                success: false,
                                error: message,
                                durationMs,
                        };

                        await this.addToConversationHistory({
                                id: crypto.randomUUID(),
                                role: "tool",
                                payloadType: "response",
                                payload: createAgentResponse({
                                        type: "tool_result",
                                        status: "error",
                                        error: message,
                                        content: toolResult,
                                }),
                                timestamp: Date.now(),
                        });

                        return createAgentResponse({
                                type: "tool_result",
                                status: "error",
                                error: message,
                                content: toolResult,
                        });
                }
        }

        private extractIntent(content: string, context: AgentContext): TravelIntent {
                const normalized = content.toLowerCase();
                const slots: Record<string, unknown> = {};

                const destinationMatch = /to\s+([a-zA-Z\s]+?)(?:[.,!?]|$)/.exec(content);
                if (destinationMatch) {
                        slots.destination = destinationMatch[1].trim();
                }

                const budgetMatch = /(under|below|around)\s+(\$?\d+)/.exec(normalized);
                if (budgetMatch) {
                        slots.budget = budgetMatch[2];
                }

                const durationMatch = /(\d+)\s+(day|night|week)/.exec(normalized);
                if (durationMatch) {
                        slots.duration = `${durationMatch[1]} ${durationMatch[2]}${Number(durationMatch[1]) > 1 ? 's' : ''}`;
                }

                const goal = normalized.includes("flight")
                        ? "plan_flight"
                        : normalized.includes("hotel")
                        ? "book_accommodation"
                        : normalized.includes("itinerary")
                        ? "design_itinerary"
                        : "general_travel_help";

                const confidence = 0.6 + Math.min(Object.keys(slots).length * 0.1, 0.3);

                return {
                        goal,
                        slots: { ...slots, ...context },
                        confidence,
                };
        }

        private buildItinerarySuggestions(intent: TravelIntent): Array<Record<string, unknown>> {
                const suggestions: Array<Record<string, unknown>> = [];

                if (intent.slots.destination) {
                        suggestions.push({
                                type: "destination_overview",
                                destination: intent.slots.destination,
                                summary: `Research local highlights in ${intent.slots.destination}.`,
                        });
                }

                if (intent.goal === "plan_flight") {
                        suggestions.push({
                                type: "flight_search",
                                parameters: {
                                        origin: intent.slots.origin ?? "current_location",
                                        destination: intent.slots.destination ?? "unknown",
                                },
                        });
                }

                if (intent.goal === "book_accommodation") {
                        suggestions.push({
                                type: "hotel_search",
                                parameters: {
                                        city: intent.slots.destination ?? "",
                                        budget: intent.slots.budget,
                                },
                        });
                }

                suggestions.push({
                        type: "conversation_followup",
                        prompt: "Ask about preferred travel dates and travelers.",
                });

                return suggestions;
        }

        private composeResponse(
                message: string,
                intent: TravelIntent,
                suggestions: Array<Record<string, unknown>>,
        ): string {
                const destination = intent.slots.destination ? ` to ${intent.slots.destination}` : "";
                const duration = intent.slots.duration ? ` for ${intent.slots.duration}` : "";
                const budget = intent.slots.budget ? ` within a budget of ${intent.slots.budget}` : "";

                const summaryParts = [
                        `I can help plan your trip${destination}${duration}${budget}.`,
                        "I'll start by gathering a few more details and lining up travel research tasks.",
                ];

                if (suggestions.length > 0) {
                        const actions = suggestions
                                .slice(0, 3)
                                .map((suggestion) => suggestion.type.replace(/_/g, " "))
                                .join(", ");
                        summaryParts.push(`Next steps include: ${actions}.`);
                }

                if (message.includes("thank")) {
                        summaryParts.push("You're welcome! Let me know if you'd like me to adjust anything.");
                }

                return summaryParts.join(" ");
        }

        private registerDefaultTools(): void {
                this.tools.registerTool("weather", async (parameters) => ({
                        provider: "placeholder",
                        location: parameters.location ?? parameters.destination ?? "unknown",
                        forecast: "Weather tool integration pending.",
                }));

                this.tools.registerTool("flights", async (parameters) => ({
                        provider: "placeholder",
                        query: parameters,
                        note: "Flight search integration pending.",
                }));

                this.tools.registerTool("hotels", async (parameters) => ({
                        provider: "placeholder",
                        query: parameters,
                        note: "Hotel search integration pending.",
                }));

                this.tools.registerTool("attractions", async (parameters) => ({
                        provider: "placeholder",
                        query: parameters,
                        note: "Attraction search integration pending.",
                }));

                this.tools.registerTool("search", async (parameters) => ({
                        provider: "placeholder",
                        query: parameters,
                        note: "Web search integration pending.",
                }));
        }
}
