import { describe, expect, it } from "vitest";

import { KVService } from "../core/kv-service";
import { MockKVNamespace } from "./mocks";

describe("KVService", () => {
        it("stores and retrieves values with prefixes", async () => {
                const kv = new KVService(new MockKVNamespace(), { prefix: "test:" });

                await kv.set("foo", { value: 42 });
                const value = await kv.get<{ value: number }>("foo");

                expect(value).toEqual({ value: 42 });
        });

        it("deletes keys", async () => {
                const kv = new KVService(new MockKVNamespace(), { prefix: "items:" });
                await kv.set("bar", { ok: true });
                await kv.delete("bar");

                const value = await kv.get("bar");
                expect(value).toBeNull();
        });

        it("lists keys relative to prefix", async () => {
                const kv = new KVService(new MockKVNamespace(), { prefix: "items:" });
                await kv.set("one", 1);
                await kv.set("two", 2);

                const keys = await kv.list();
                expect(keys.sort()).toEqual(["one", "two"]);
        });
});
