export class MockKVNamespace implements KVNamespace {
        private store = new Map<string, { value: string; expiration?: number }>();

        async get(key: string): Promise<string | null> {
                const entry = this.store.get(key);
                if (!entry) {
                        return null;
                }

                if (entry.expiration && entry.expiration < Date.now()) {
                        this.store.delete(key);
                        return null;
                }

                return entry.value;
        }

        async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
                const ttlSeconds = options?.expirationTtl;
                const expiration = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
                this.store.set(key, { value, expiration });
        }

        async delete(key: string): Promise<void> {
                this.store.delete(key);
        }

        async list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult> {
                const prefix = options?.prefix ?? "";
                const keys = Array.from(this.store.entries())
                        .filter(([name]) => name.startsWith(prefix))
                        .map(([name]) => ({ name }));
                return { keys, list_complete: true };
        }
}

export class MockR2Bucket implements R2Bucket {
        private store = new Map<string, { body: Uint8Array; httpMetadata?: R2HTTPMetadata; metadata?: Record<string, string>; uploaded: Date }>();

        async put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object> {
                let bytes: Uint8Array;
                if (typeof value === "string") {
                        bytes = new TextEncoder().encode(value);
                } else if (value instanceof ArrayBuffer) {
                        bytes = new Uint8Array(value);
                } else if (ArrayBuffer.isView(value)) {
                        bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
                } else if (value instanceof ReadableStream) {
                        const chunks: Uint8Array[] = [];
                        const reader = value.getReader();
                        // eslint-disable-next-line no-constant-condition
                        while (true) {
                                const { value: chunk, done } = await reader.read();
                                if (done) break;
                                if (chunk) {
                                        chunks.push(chunk);
                                }
                        }
                        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
                        bytes = new Uint8Array(totalLength);
                        let offset = 0;
                        for (const chunk of chunks) {
                                bytes.set(chunk, offset);
                                offset += chunk.byteLength;
                        }
                } else if (value instanceof Blob) {
                        bytes = new Uint8Array(await value.arrayBuffer());
                } else {
                        throw new Error("Unsupported mock R2 body type");
                }

                const uploaded = new Date();
                const httpMetadata = options?.httpMetadata;
                const customMetadata = options?.customMetadata;
                this.store.set(key, {
                        body: bytes,
                        httpMetadata,
                        metadata: customMetadata,
                        uploaded,
                });

                return {
                        key,
                        size: bytes.byteLength,
                        uploaded,
                        etag: `etag-${key}`,
                        httpMetadata,
                        customMetadata,
                } as unknown as R2Object;
        }

        async get(key: string): Promise<R2ObjectBody | null> {
                const entry = this.store.get(key);
                if (!entry) {
                        return null;
                }

                const body = entry.body;
                return {
                        key,
                        size: body.byteLength,
                        body,
                        arrayBuffer: async () => body.slice().buffer,
                        httpMetadata: entry.httpMetadata,
                        customMetadata: entry.metadata ?? {},
                        etag: `etag-${key}`,
                        uploaded: entry.uploaded,
                } as unknown as R2ObjectBody;
        }

        async delete(key: string | string[]): Promise<void> {
                if (Array.isArray(key)) {
                        key.forEach((k) => this.store.delete(k));
                } else {
                        this.store.delete(key);
                }
        }

        async list(options?: R2ListOptions): Promise<R2Objects> {
                const prefix = options?.prefix ?? "";
                const objects = Array.from(this.store.entries())
                        .filter(([key]) => key.startsWith(prefix))
                        .map(([key, value]) => ({
                                key,
                                size: value.body.byteLength,
                                uploaded: value.uploaded,
                                customMetadata: value.metadata,
                                httpMetadata: value.httpMetadata,
                        }));
                return { objects, truncated: false } as unknown as R2Objects;
        }

        async head(): Promise<R2Object | null> {
                throw new Error("Not implemented in mock");
        }

        async createMultipartUpload(): Promise<R2MultipartUpload> {
                throw new Error("Not implemented in mock");
        }

        resumeMultipartUpload(): Promise<R2MultipartUpload> {
                throw new Error("Not implemented in mock");
        }
}
