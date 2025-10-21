import { describe, expect, it } from "vitest";

import { R2StorageService } from "../core/r2-storage";
import { MockR2Bucket } from "./mocks";

const createService = () =>
        new R2StorageService({
                scrapedData: new MockR2Bucket(),
                userUploads: new MockR2Bucket(),
                cache: new MockR2Bucket(),
        });

describe("R2StorageService", () => {
        it("uploads and retrieves user uploads", async () => {
                const service = createService();
                const encoder = new TextEncoder();
                const stored = await service.storeUserUpload({
                        data: encoder.encode("test file"),
                        size: encoder.encode("test file").byteLength,
                        contentType: "text/plain",
                        filename: "note.txt",
                });

                expect(stored.bucket).toBe("userUploads");

                const retrieved = await service.getObject("userUploads", stored.key);
                expect(retrieved).not.toBeNull();
                if (retrieved) {
                        const text = new TextDecoder().decode(new Uint8Array(retrieved.body));
                        expect(text).toBe("test file");
                }
        });

        it("rejects invalid scraped content types", async () => {
                const service = createService();
                const encoder = new TextEncoder();

                await expect(
                        service.storeScrapedContent({
                                data: encoder.encode("binary"),
                                size: encoder.encode("binary").byteLength,
                                contentType: "image/png",
                        }),
                ).rejects.toBeInstanceOf(Error);
        });

        it("creates cache pointers", async () => {
                const service = createService();
                const encoder = new TextEncoder();
                const stored = await service.storeCacheEntry({
                        data: encoder.encode("cache"),
                        size: encoder.encode("cache").byteLength,
                        contentType: "text/plain",
                        ttlSeconds: 60,
                });

                const pointer = await service.buildCachePointer(stored, 60);
                expect(pointer.bucket).toBe("cache");
                expect(pointer.key).toBe(stored.key);
                expect(pointer.size).toBe(stored.size);
        });
});
