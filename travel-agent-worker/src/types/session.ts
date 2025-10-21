export type SessionMessageRole = 'user' | 'assistant' | 'system';

export interface SessionMessage {
        id: string;
        role: SessionMessageRole;
        content: string;
        timestamp: number;
        metadata?: Record<string, unknown>;
}

export interface SessionData {
        id: string;
        threadId: string;
        userId?: string;
        createdAt: number;
        lastAccessedAt: number;
        expiresAt?: number;
        metadata: Record<string, unknown>;
        messages: SessionMessage[];
}

export interface CreateSessionInput {
        id?: string;
        threadId: string;
        userId?: string;
        ttlSeconds?: number;
        metadata?: Record<string, unknown>;
        messages?: SessionMessage[];
}

export interface SessionUpdate {
        userId?: string;
        threadId?: string;
        lastAccessedAt?: number;
        expiresAt?: number;
        metadata?: Record<string, unknown>;
        messages?: SessionMessage[];
}

export interface SessionStore {
        createSession(sessionData: CreateSessionInput): Promise<string>;
        getSession(sessionId: string): Promise<SessionData | null>;
        updateSession(sessionId: string, updates: SessionUpdate): Promise<void>;
        deleteSession(sessionId: string): Promise<void>;
        extendSession(sessionId: string, ttlSeconds: number): Promise<void>;
        appendMessages(sessionId: string, messages: SessionMessage[], limit?: number): Promise<void>;
        touch(sessionId: string): Promise<void>;
}
