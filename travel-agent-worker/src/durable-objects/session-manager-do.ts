import { BaseAgentDO } from "./base-agent-do";
import type {
        AgentContext,
        AgentMessage,
        AgentResponse,
        AgentState,
        SessionRecord,
} from "../types/durable-object-types";
import type { WorkerEnv } from "../types/env";
import { createAgentResponse } from "../utils/do-helpers";

interface SessionMutationContent {
        sessionId?: string;
        attributes?: Record<string, unknown>;
        conversationId?: string;
        action?: 'touch' | 'delete';
}

export class SessionManagerDO extends BaseAgentDO {
        constructor(state: DurableObjectState, env: WorkerEnv) {
                super(state, env);
        }

        protected override createInitialState(): AgentState {
                const base = super.createInitialState();
                return {
                        ...base,
                        context: { ...base.context, agentType: "session_manager" },
                        cache: { sessions: {} },
                };
        }

        protected async handleMessage(message: AgentMessage): Promise<AgentResponse> {
                const context = message.context ?? {};
                switch (message.type) {
                        case "session_get":
                                return this.getSession(message.content);
                        case "session_update":
                                return this.updateSessionRecord(message.content, context);
                        case "session_delete":
                                return this.deleteSessionRecord(message.content);
                        case "session_list":
                                return this.listSessions();
                        default:
                                return createAgentResponse({
                                        type: "error",
                                        status: "error",
                                        content: null,
                                        error: `Unsupported message type: ${message.type}`,
                                });
                }
        }

        private async getSession(content: unknown): Promise<AgentResponse> {
                const payload = (content as SessionMutationContent) ?? {};
                const sessionId = payload.sessionId;
                if (!sessionId) {
                        return createAgentResponse({
                                type: "session",
                                status: "error",
                                content: null,
                                error: "sessionId is required",
                        });
                }

                const record = await this.storage.get<SessionRecord>(this.sessionKey(sessionId));
                if (!record) {
                        return createAgentResponse({
                                type: "session",
                                status: "error",
                                content: null,
                                error: "Session not found",
                        });
                }

                return createAgentResponse({
                        type: "session",
                        content: record,
                });
        }

        private async updateSessionRecord(content: unknown, context: AgentContext): Promise<AgentResponse> {
                const payload = (content as SessionMutationContent) ?? {};
                const sessionId = payload.sessionId ?? crypto.randomUUID();
                const key = this.sessionKey(sessionId);
                const existing = await this.storage.get<SessionRecord>(key);
                const now = Date.now();

                const record: SessionRecord = {
                        id: sessionId,
                        userId: context.userId,
                        createdAt: existing?.createdAt ?? now,
                        updatedAt: now,
                        attributes: {
                                ...(existing?.attributes ?? {}),
                                ...(payload.attributes ?? {}),
                        },
                        conversationIds: Array.from(
                                new Set([
                                        ...(existing?.conversationIds ?? []),
                                        ...(payload.conversationId ? [payload.conversationId] : []),
                                ]),
                        ),
                };

                await this.storage.put(key, record);
                await this.addSessionHistory(record, payload.action ?? "update");

                return createAgentResponse({
                        type: "session_update",
                        content: record,
                });
        }

        private async deleteSessionRecord(content: unknown): Promise<AgentResponse> {
                const payload = (content as SessionMutationContent) ?? {};
                const sessionId = payload.sessionId;
                if (!sessionId) {
                        return createAgentResponse({
                                type: "session_delete",
                                status: "error",
                                content: null,
                                error: "sessionId is required",
                        });
                }

                await this.storage.delete(this.sessionKey(sessionId));
                await this.addSessionHistory(
                        {
                                id: sessionId,
                                userId: undefined,
                                createdAt: Date.now(),
                                updatedAt: Date.now(),
                                attributes: {},
                                conversationIds: [],
                        },
                        "delete",
                );

                return createAgentResponse({
                        type: "session_delete",
                        content: { sessionId },
                });
        }

        private async listSessions(): Promise<AgentResponse> {
                const sessions = await this.storage.list<SessionRecord>({ prefix: "session:" });
                const values = Array.from(sessions.values());

                return createAgentResponse({
                        type: "session_list",
                        content: values,
                });
        }

        private sessionKey(sessionId: string): string {
                return `session:${sessionId}`;
        }

        private async addSessionHistory(record: SessionRecord, action: string): Promise<void> {
                await this.addToConversationHistory({
                        id: crypto.randomUUID(),
                        role: "system",
                        payloadType: "message",
                        payload: {
                                id: crypto.randomUUID(),
                                type: "session_event",
                                content: { action, record },
                        },
                        timestamp: Date.now(),
                });
        }
}
