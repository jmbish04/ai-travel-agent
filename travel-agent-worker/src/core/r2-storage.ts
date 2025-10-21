import {
        computeBodySize,
        normaliseContentType,
        validateFile,
        type FileValidationOptions,
} from "../utils/file-validation";
import type {
        CachePointer,
        R2BucketTarget,
        R2ObjectRetrieval,
        R2StorageBindings,
        R2StoredObject,
        R2UploadBody,
} from "../types/r2";

interface UploadOptions extends FileValidationOptions {
        metadata?: Record<string, string>;
        retries?: number;
}

interface CacheUploadOptions extends UploadOptions {
        ttlSeconds?: number;
}

const DEFAULT_RETRIES = 2;
const SCRAPED_PREFIX = "scraped/";
const UPLOAD_PREFIX = "uploads/";
const CACHE_PREFIX = "cache/";

export class R2StorageError extends Error {
        constructor(message: string, cause?: unknown) {
                super(message);
                this.name = "R2StorageError";
                if (cause instanceof Error && cause.stack) {
                        this.stack = cause.stack;
                }
        }
}

export class R2StorageService {
        private buckets: R2StorageBindings;

        constructor(buckets: R2StorageBindings) {
                this.buckets = buckets;
        }

        async storeScrapedContent(request: R2UploadBody & UploadOptions): Promise<R2StoredObject> {
                const key = request.key ?? this.generateKey(SCRAPED_PREFIX);
                const allowedMimeTypes = request.allowedMimeTypes ?? [
                        "text/html",
                        "text/plain",
                        "application/json",
                ];

                return this.upload("scrapedData", key, request, {
                        ...request,
                        allowedMimeTypes,
                });
        }

        async storeUserUpload(request: R2UploadBody & UploadOptions): Promise<R2StoredObject> {
                const key = request.key ?? this.generateKey(UPLOAD_PREFIX);
                const allowedMimeTypes = request.allowedMimeTypes ?? [
                        "image/png",
                        "image/jpeg",
                        "application/pdf",
                        "application/msword",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "application/vnd.ms-excel",
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        "text/plain",
                        "application/json",
                ];

                return this.upload("userUploads", key, request, {
                        ...request,
                        allowedMimeTypes,
                });
        }

        async storeCacheEntry(request: R2UploadBody & CacheUploadOptions): Promise<R2StoredObject> {
                const key = request.key ?? this.generateKey(CACHE_PREFIX);
                const stored = await this.upload("cache", key, request, request);

                if (request.ttlSeconds) {
                        stored.metadata.expiresAt = new Date(
                                Date.now() + request.ttlSeconds * 1000,
                        ).toISOString();
                }

                return stored;
        }

        async getObject(bucket: R2BucketTarget, key: string): Promise<R2ObjectRetrieval | null> {
                const bucketBinding = this.getBucket(bucket);

                try {
                        const object = await bucketBinding.get(key);
                        if (!object) {
                                return null;
                        }

                        const body = await object.arrayBuffer();

                        return {
                                key,
                                bucket,
                                body,
                                size: body.byteLength,
                                contentType: object.httpMetadata?.contentType ?? undefined,
                                metadata: object.customMetadata ?? {},
                                etag: object.etag,
                                uploadedAt: object.uploaded?.toISOString(),
                        };
                } catch (error) {
                        throw new R2StorageError(`Failed to fetch object ${key} from R2`, error);
                }
        }

        async deleteObject(bucket: R2BucketTarget, key: string): Promise<void> {
                const bucketBinding = this.getBucket(bucket);

                try {
                        await bucketBinding.delete(key);
                } catch (error) {
                        throw new R2StorageError(`Failed to delete object ${key} from R2`, error);
                }
        }

        async listObjects(bucket: R2BucketTarget, prefix?: string): Promise<string[]> {
                const bucketBinding = this.getBucket(bucket);

                try {
                        const result = await bucketBinding.list({ prefix });
                        return result.objects.map((obj) => obj.key);
                } catch (error) {
                        throw new R2StorageError("Failed to list objects from R2", error);
                }
        }

        async buildCachePointer(
                stored: R2StoredObject,
                ttlSeconds?: number,
        ): Promise<CachePointer> {
                return {
                        bucket: stored.bucket,
                        key: stored.key,
                        size: stored.size,
                        contentType: stored.contentType,
                        expiresAt:
                                ttlSeconds !== undefined
                                        ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
                                        : stored.metadata.expiresAt,
                };
        }

        private async upload(
                bucketName: R2BucketTarget,
                key: string,
                request: R2UploadBody & UploadOptions,
                validation: UploadOptions,
        ): Promise<R2StoredObject> {
                const bucket = this.getBucket(bucketName);
                const retries = validation.retries ?? DEFAULT_RETRIES;
                const contentType = normaliseContentType(request.contentType);
                const size = request.size ?? computeBodySize(request.data);

                validateFile(
                        {
                                size,
                                contentType,
                                filename: request.filename,
                        },
                        validation,
                );

                const metadata = { ...(request.metadata ?? {}) };
                const putOptions: R2PutOptions = {
                        httpMetadata: { contentType },
                        customMetadata: metadata,
                };

                const response = await this.retry(async () => bucket.put(key, request.data, putOptions), retries);

                return {
                        key,
                        bucket: bucketName,
                        size,
                        etag: response?.etag,
                        uploadedAt: response?.uploaded?.toISOString() ?? new Date().toISOString(),
                        contentType,
                        metadata,
                };
        }

        private getBucket(bucket: R2BucketTarget): R2Bucket {
                switch (bucket) {
                        case "scrapedData":
                                return this.buckets.scrapedData;
                        case "userUploads":
                                return this.buckets.userUploads;
                        case "cache":
                                return this.buckets.cache;
                        default:
                                throw new R2StorageError(`Unknown bucket target: ${bucket}`);
                }
        }

        private generateKey(prefix: string): string {
                return `${prefix}${new Date().toISOString()}-${crypto.randomUUID()}`;
        }

        private async retry<T>(operation: () => Promise<T>, retries: number): Promise<T> {
                let attempt = 0;
                let delayMs = 100;

                // eslint-disable-next-line no-constant-condition
                while (true) {
                        try {
                                return await operation();
                        } catch (error) {
                                if (attempt >= retries) {
                                        throw new R2StorageError("R2 operation failed after retries", error);
                                }
                                await this.sleep(delayMs);
                                attempt += 1;
                                delayMs *= 2;
                        }
                }
        }

        private async sleep(ms: number): Promise<void> {
                if (typeof scheduler !== "undefined" && typeof scheduler.wait === "function") {
                        await scheduler.wait(ms);
                        return;
                }

                if (typeof setTimeout === "function") {
                        await new Promise((resolve) => setTimeout(resolve, ms));
                        return;
                }

                await Promise.resolve();
        }
}
