import { deserializeValue, serializeValue } from "../utils/serialization";

interface KVServiceOptions {
        prefix?: string;
}

export class KVServiceError extends Error {
        constructor(message: string, cause?: unknown) {
                super(message);
                this.name = "KVServiceError";
                if (cause instanceof Error && cause.stack) {
                        this.stack = cause.stack;
                }
        }
}

export class KVService {
        private namespace: KVNamespace;
        private prefix: string;

        constructor(namespace: KVNamespace, options: KVServiceOptions = {}) {
                this.namespace = namespace;
                this.prefix = options.prefix ?? "";
        }

        withPrefix(prefix: string): KVService {
                const combined = this.prefix ? `${this.prefix}${prefix}` : prefix;
                return new KVService(this.namespace, { prefix: combined });
        }

        async get<T>(key: string): Promise<T | null> {
                try {
                        const stored = await this.namespace.get(this.applyPrefix(key));
                        return deserializeValue<T>(stored);
                } catch (error) {
                        throw new KVServiceError(`Failed to get key ${key} from KV`, error);
                }
        }

        async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
                try {
                        const payload = serializeValue(value);
                        await this.namespace.put(this.applyPrefix(key), payload, {
                                expirationTtl: ttlSeconds,
                        });
                } catch (error) {
                        throw new KVServiceError(`Failed to set key ${key} in KV`, error);
                }
        }

        async delete(key: string): Promise<void> {
                try {
                        await this.namespace.delete(this.applyPrefix(key));
                } catch (error) {
                        throw new KVServiceError(`Failed to delete key ${key} from KV`, error);
                }
        }

        async list(prefix?: string): Promise<string[]> {
                try {
                        const effectivePrefix = prefix ? this.applyPrefix(prefix) : this.prefix;
                        const result = await this.namespace.list({ prefix: effectivePrefix });

                        return result.keys.map((entry) => this.stripPrefix(entry.name));
                } catch (error) {
                        throw new KVServiceError("Failed to list keys from KV", error);
                }
        }

        private applyPrefix(key: string): string {
                return `${this.prefix}${key}`;
        }

        private stripPrefix(key: string): string {
                if (!this.prefix) {
                        return key;
                }

                if (key.startsWith(this.prefix)) {
                        return key.slice(this.prefix.length);
                }

                return key;
        }
}
