export type R2BucketTarget = 'scrapedData' | 'userUploads' | 'cache';

export interface R2StorageBindings {
        scrapedData: R2Bucket;
        userUploads: R2Bucket;
        cache: R2Bucket;
}

export interface R2UploadBody {
        key?: string;
        data: ArrayBuffer | ArrayBufferView | ReadableStream | Blob | string;
        size?: number;
        contentType?: string;
        filename?: string;
        metadata?: Record<string, string>;
        retries?: number;
        maxSizeBytes?: number;
        allowedMimeTypes?: string[];
}

export interface R2StoredObject {
        key: string;
        bucket: R2BucketTarget;
        size: number;
        etag?: string;
        uploadedAt: string;
        contentType?: string;
        metadata: Record<string, string>;
}

export interface R2ObjectRetrieval {
        key: string;
        bucket: R2BucketTarget;
        body: ArrayBuffer;
        size: number;
        contentType?: string;
        metadata: Record<string, string>;
        etag?: string;
        uploadedAt?: string;
}

export interface CachePointer {
        bucket: R2BucketTarget;
        key: string;
        expiresAt?: string;
        size: number;
        contentType?: string;
}
