/**
 * JSON serialization helpers used across storage layers.
 */

export class SerializationError extends Error {
        constructor(message: string, cause?: unknown) {
                super(message);
                this.name = "SerializationError";
                if (cause instanceof Error && cause.stack) {
                        this.stack = cause.stack;
                }
        }
}

/**
 * Safely serializes a value into JSON.
 */
export function serializeValue<T>(value: T): string {
        try {
                return JSON.stringify(value);
        } catch (error) {
                throw new SerializationError("Failed to serialize value to JSON", error);
        }
}

/**
 * Safely parses a JSON string into an object.
 */
export function deserializeValue<T>(value: string | null): T | null {
        if (value === null) {
                return null;
        }

        try {
                return JSON.parse(value) as T;
        } catch (error) {
                throw new SerializationError("Failed to deserialize JSON value", error);
        }
}

/**
 * Helper to decode a base64 string into a Uint8Array.
 */
export function decodeBase64(data: string): Uint8Array {
        try {
                const decoded = atob(data);
                const bytes = new Uint8Array(decoded.length);
                for (let i = 0; i < decoded.length; i += 1) {
                        bytes[i] = decoded.charCodeAt(i);
                }
                return bytes;
        } catch (error) {
                throw new SerializationError("Invalid base64 payload", error);
        }
}

/**
 * Encodes a Uint8Array into a base64 string.
 */
export function encodeBase64(data: Uint8Array): string {
        let binary = "";
        for (let i = 0; i < data.length; i += 1) {
                binary += String.fromCharCode(data[i]);
        }
        return btoa(binary);
}
