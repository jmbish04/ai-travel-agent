import type { AgentToolResult } from "../tools/agent-tool-registry";

export type TravelAgentType =
        | "meta"
        | "weather"
        | "destination"
        | "booking"
        | "attractions"
        | "scraping";

export interface AgentContext {
        sessionId: string;
        threadId: string;
        userId?: string;
        locale?: string;
        timezone?: string;
        metadata?: Record<string, unknown>;
}

export interface AgentMetadata {
        agentType: TravelAgentType;
        version: string;
        capabilities: string[];
}

export interface TravelIntentBase {
        type: TravelAgentType;
        confidence?: number;
        slots?: Record<string, unknown>;
        raw?: unknown;
}

export interface WeatherIntent extends TravelIntentBase {
        type: "weather";
        destination: string;
        dates?: { start?: string; end?: string };
}

export interface DestinationIntent extends TravelIntentBase {
        type: "destination";
        query: string;
        preferences?: Record<string, unknown>;
        budget?: { currency: string; amount: number };
}

export interface BookingIntent extends TravelIntentBase {
        type: "booking";
        bookingType: "flight" | "hotel" | "package";
        criteria: Record<string, unknown>;
        userPreferences?: Record<string, unknown>;
}

export interface AttractionsIntent extends TravelIntentBase {
        type: "attractions";
        destination: string;
        travelDates?: { start?: string; end?: string };
        interests?: string[];
}

export type TravelIntent =
        | TravelIntentBase
        | WeatherIntent
        | DestinationIntent
        | BookingIntent
        | AttractionsIntent;

export interface AgentResponse<TContent = unknown> {
        type: "chat_response" | "tool_result" | "error" | string;
        content: TContent;
        confidence?: number;
        sources?: string[];
        metadata?: Record<string, unknown> & {
                intent?: TravelIntent;
                toolsUsed?: string[];
                timestamp?: number;
        };
}

export interface ValidationResult {
        ok: boolean;
        issues?: string[];
        response: AgentResponse;
}

export interface AgentState {
        agentId: string;
        sessionId: string;
        userId?: string;
        conversationHistory: ConversationTurn[];
        extractedSlots: Record<string, unknown>;
        preferences: Record<string, unknown>;
        currentIntent?: TravelIntent;
        context: AgentContext;
        metadata: AgentMetadata;
        createdAt: number;
        lastUpdated: number;
}

export interface ConversationTurn {
        id: string;
        timestamp: number;
        userMessage: string;
        agentResponse?: AgentResponse;
        intent?: TravelIntent;
        confidence?: number;
        toolResults?: AgentToolResult[];
}

export interface ToolCallPlan {
        name: string;
        parameters: Record<string, unknown>;
}

export interface RoutingDecision {
        primaryAgent: TravelAgentType;
        additionalAgents: TravelAgentType[];
        confidence: number;
}

export interface AgentMessage {
        type: string;
        content: unknown;
        context?: AgentContext;
        metadata?: Record<string, unknown>;
}

export interface AgentToolDescriptor {
        name: string;
        supportedAgents: TravelAgentType[];
        description?: string;
}

export interface AgentTool {
        readonly name: string;
        readonly supportedAgents: TravelAgentType[];
        execute(params: Record<string, unknown>, context: AgentContext): Promise<AgentToolResult>;
}
