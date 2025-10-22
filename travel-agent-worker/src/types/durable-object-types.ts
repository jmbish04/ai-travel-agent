export type AgentMessageType =
        | 'chat'
        | 'tool_call'
        | 'state_query'
        | 'start_conversation'
        | 'route_message'
        | 'coordinate_agents'
        | 'queue_task'
        | 'complete_task'
        | 'status'
        | 'session_get'
        | 'session_update'
        | 'session_delete'
        | 'session_list';

export interface AgentContext {
        userId?: string;
        sessionId?: string;
        conversationId?: string;
        threadId?: string;
        [key: string]: unknown;
}

export interface AgentMessage<TContent = unknown> {
        id?: string;
        type: AgentMessageType | (string & {});
        content: TContent;
        context?: AgentContext;
        metadata?: Record<string, unknown>;
}

export interface AgentResponse<TContent = unknown> {
        id?: string;
        type: string;
        status?: 'ok' | 'error';
        content: TContent;
        metadata?: Record<string, unknown>;
        error?: string;
        confidence?: number;
        sources?: string[];
}

export interface ConversationEntry {
        id: string;
        role: 'user' | 'assistant' | 'system' | 'tool';
        payloadType: 'message' | 'response';
        payload: AgentMessage | AgentResponse;
        timestamp: number;
        metadata?: Record<string, unknown>;
}

export interface AgentState {
        id: string;
        createdAt: number;
        lastUpdated: number;
        conversationHistory: ConversationEntry[];
        extractedSlots: Record<string, unknown>;
        preferences: Record<string, unknown>;
        context: AgentContext;
        cache?: Record<string, unknown>;
}

export interface ToolCall {
        name: string;
        parameters?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
}

export interface ToolResult {
        toolCall: ToolCall;
        success: boolean;
        data?: unknown;
        error?: unknown;
        durationMs?: number;
}

export interface ConversationDescriptor {
        id: string;
        userId?: string;
        startedAt: number;
        lastActiveAt: number;
        participants: string[];
        phase?: string;
        metadata?: Record<string, unknown>;
}

export interface SessionRecord {
        id: string;
        userId?: string;
        createdAt: number;
        updatedAt: number;
        attributes: Record<string, unknown>;
        conversationIds: string[];
}
