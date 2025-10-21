import { KVService } from "./kv-service";
import type {
        CreateSessionInput,
        SessionData,
        SessionMessage,
        SessionStore,
        SessionUpdate,
} from "../types/session";

interface SessionKvStoreOptions {
        defaultTtlSeconds?: number;
        maxMessages?: number;
}

const DEFAULT_SESSION_TTL = 60 * 60 * 4; // 4 hours
const DEFAULT_MAX_MESSAGES = 200;

export class SessionKvStore implements SessionStore {
        private kv: KVService;
        private defaultTtlSeconds: number;
        private maxMessages: number;

        constructor(kv: KVService, options: SessionKvStoreOptions = {}) {
                this.kv = kv;
                this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_SESSION_TTL;
                this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
        }

        async createSession(sessionData: CreateSessionInput): Promise<string> {
                const sessionId = sessionData.id ?? crypto.randomUUID();
                const now = Date.now();
                const ttlSeconds = sessionData.ttlSeconds ?? this.defaultTtlSeconds;
                const expiresAt = now + ttlSeconds * 1000;

                const session: SessionData = {
                        id: sessionId,
                        threadId: sessionData.threadId,
                        userId: sessionData.userId,
                        createdAt: now,
                        lastAccessedAt: now,
                        expiresAt,
                        metadata: sessionData.metadata ?? {},
                        messages: sessionData.messages ?? [],
                };

                await this.kv.set(sessionId, session, ttlSeconds);

                return sessionId;
        }

        async getSession(sessionId: string): Promise<SessionData | null> {
                const session = await this.kv.get<SessionData>(sessionId);
                return session;
        }

        async updateSession(sessionId: string, updates: SessionUpdate): Promise<void> {
                const session = await this.getSessionOrThrow(sessionId);

                const mergedMetadata = {
                        ...session.metadata,
                        ...updates.metadata,
                } satisfies Record<string, unknown>;

                const updated: SessionData = {
                        ...session,
                        ...updates,
                        metadata: mergedMetadata,
                        messages: updates.messages ?? session.messages,
                };

                const ttlSeconds = this.computeRemainingTtl(updated.expiresAt);
                await this.kv.set(sessionId, updated, ttlSeconds);
        }

        async deleteSession(sessionId: string): Promise<void> {
                await this.kv.delete(sessionId);
        }

        async extendSession(sessionId: string, ttlSeconds: number): Promise<void> {
                const session = await this.getSessionOrThrow(sessionId);
                const now = Date.now();
                const newExpiresAt = now + ttlSeconds * 1000;

                await this.updateSession(sessionId, {
                        expiresAt: newExpiresAt,
                        lastAccessedAt: now,
                });
        }

        async appendMessages(
                sessionId: string,
                messages: SessionMessage[],
                limit = this.maxMessages,
        ): Promise<void> {
                if (messages.length === 0) {
                        return;
                }

                const session = await this.getSessionOrThrow(sessionId);
                const combined = [...session.messages, ...messages];
                const trimmed = combined.slice(-limit);

                await this.updateSession(sessionId, {
                        messages: trimmed,
                        lastAccessedAt: Date.now(),
                });
        }

        async touch(sessionId: string): Promise<void> {
                await this.updateSession(sessionId, { lastAccessedAt: Date.now() });
        }

        private async getSessionOrThrow(sessionId: string): Promise<SessionData> {
                const session = await this.getSession(sessionId);
                if (!session) {
                        throw new Error(`Session ${sessionId} not found`);
                }
                return session;
        }

        private computeRemainingTtl(expiresAt?: number): number | undefined {
                if (!expiresAt) {
                        return undefined;
                }

                const now = Date.now();
                const remainingMs = expiresAt - now;
                if (remainingMs <= 0) {
                        return this.defaultTtlSeconds;
                }

                return Math.ceil(remainingMs / 1000);
        }
}
