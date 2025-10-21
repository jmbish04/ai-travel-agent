import { describe, expect, it } from "vitest";

import { SessionKvStore } from "../core/session-kv-store";
import { KVService } from "../core/kv-service";
import type { SessionMessage } from "../types/session";
import { MockKVNamespace } from "./mocks";

describe("SessionKvStore", () => {
        const createStore = () => new SessionKvStore(new KVService(new MockKVNamespace()));

        it("creates and retrieves sessions", async () => {
                const store = createStore();
                const sessionId = await store.createSession({ threadId: "thread-1" });

                const session = await store.getSession(sessionId);
                expect(session).not.toBeNull();
                expect(session?.threadId).toBe("thread-1");
        });

        it("appends messages and respects max limit", async () => {
                const store = new SessionKvStore(new KVService(new MockKVNamespace()), {
                        maxMessages: 2,
                });
                const sessionId = await store.createSession({ threadId: "thread-2" });

                const messages: SessionMessage[] = [
                        { id: "1", role: "user", content: "hello", timestamp: Date.now() },
                        { id: "2", role: "assistant", content: "hi", timestamp: Date.now() },
                        { id: "3", role: "user", content: "again", timestamp: Date.now() },
                ];

                await store.appendMessages(sessionId, messages);
                const session = await store.getSession(sessionId);

                expect(session?.messages).toHaveLength(2);
                expect(session?.messages[0].id).toBe("2");
                expect(session?.messages[1].id).toBe("3");
        });

        it("extends session TTL", async () => {
                const store = createStore();
                const sessionId = await store.createSession({ threadId: "thread-3", ttlSeconds: 1 });
                await store.extendSession(sessionId, 120);
                const session = await store.getSession(sessionId);

                expect(session?.expiresAt).toBeGreaterThan(Date.now());
        });
});
