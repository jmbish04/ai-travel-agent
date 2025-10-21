/**
 * Utility helpers for validating file uploads before storing them in R2.
 */

export interface FileDescriptor {
        size: number;
        contentType?: string;
        filename?: string;
}

export interface FileValidationOptions {
        maxSizeBytes?: number;
        allowedMimeTypes?: string[];
        disallowedExtensions?: string[];
}

export class FileValidationError extends Error {
        constructor(message: string) {
                super(message);
                this.name = "FileValidationError";
        }
}

const DEFAULT_MAX_SIZE = 25 * 1024 * 1024; // 25 MiB

/**
 * Validates a file descriptor against provided constraints.
 */
export function validateFile(
        descriptor: FileDescriptor,
        options: FileValidationOptions = {},
): void {
        const maxSize = options.maxSizeBytes ?? DEFAULT_MAX_SIZE;
        if (descriptor.size > maxSize) {
                throw new FileValidationError(
                        `File exceeds maximum allowed size of ${maxSize} bytes (received ${descriptor.size} bytes)`,
                );
        }

        if (options.allowedMimeTypes && descriptor.contentType) {
                const isAllowed = options.allowedMimeTypes.some((type) =>
                        matchesMimeType(descriptor.contentType as string, type),
                );
                if (!isAllowed) {
                        throw new FileValidationError(
                                `Content type ${descriptor.contentType} is not permitted`,
                        );
                }
        }

        if (options.disallowedExtensions && descriptor.filename) {
                const extension = descriptor.filename.split(".").pop()?.toLowerCase();
                if (extension && options.disallowedExtensions.includes(extension)) {
                        throw new FileValidationError(`File extension .${extension} is not permitted`);
                }
        }
}

/**
 * Performs a wildcard aware MIME type comparison, supporting patterns like `image/*`.
 */
export function matchesMimeType(contentType: string, pattern: string): boolean {
        if (pattern === "*/*") {
                return true;
        }

        if (pattern.endsWith("/*")) {
                const [type] = pattern.split("/");
                return contentType.startsWith(`${type}/`);
        }

        return contentType.toLowerCase() === pattern.toLowerCase();
}

/**
 * Calculates the size of a body input.
 */
export function computeBodySize(body: BodyInit | ArrayBuffer | ArrayBufferView): number {
        if (body instanceof ArrayBuffer) {
                return body.byteLength;
        }

        if (ArrayBuffer.isView(body)) {
                return body.byteLength;
        }

        if (typeof body === "string") {
                return new TextEncoder().encode(body).byteLength;
        }

        if (body instanceof Blob) {
                return body.size;
        }

        if (body instanceof ReadableStream) {
                throw new FileValidationError(
                        "ReadableStream bodies require an explicit size to be provided for validation",
                );
        }

        if ((body as ArrayBuffer | ArrayBufferView).byteLength !== undefined) {
                return (body as ArrayBuffer | ArrayBufferView).byteLength;
        }

        throw new FileValidationError("Unsupported body type for size computation");
}

/**
 * Normalises a MIME type, falling back to `application/octet-stream` when not provided.
 */
export function normaliseContentType(contentType?: string): string {
        return contentType && contentType.trim().length > 0
                ? contentType
                : "application/octet-stream";
}
