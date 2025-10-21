export interface DurableObjectStub {
        fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface AgentDurableObjectState {
        id: string;
        createdAt: number;
        lastUpdated: number;
        conversationHistory: unknown[];
        metadata?: Record<string, unknown>;
}
