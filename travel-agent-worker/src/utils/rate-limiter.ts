import { KVService } from "../core/kv-service";

interface RateLimiterOptions {
        windowSizeSeconds?: number;
        maxRequests?: number;
}

interface RateLimitWindow {
        timestamps: number[];
}

/**
 * Sliding window rate limiter backed by Cloudflare KV.
 */
export class RateLimiter {
        private kv: KVService;
        private windowSizeSeconds: number;
        private maxRequests: number;

        constructor(kv: KVService, options: RateLimiterOptions = {}) {
                this.kv = kv;
                this.windowSizeSeconds = options.windowSizeSeconds ?? 60;
                this.maxRequests = options.maxRequests ?? 100;
        }

        async acquire(key: string): Promise<boolean> {
                const now = Math.floor(Date.now() / 1000);
                const windowStart = now - this.windowSizeSeconds;

                try {
                        const record = await this.kv.get<RateLimitWindow>(key);
                        const validTimestamps = record ? record.timestamps.filter((timestamp) => timestamp > windowStart) : [];
                        const validTimestamps = record.timestamps.filter((timestamp) => timestamp > windowStart);

                        if (validTimestamps.length >= this.maxRequests) {
                                return false;
                        }

                        validTimestamps.push(now);
                        await this.kv.set<RateLimitWindow>(
                                key,
                                { timestamps: validTimestamps },
                                this.windowSizeSeconds + 10,
                        );

                        return true;
                } catch (error) {
                        console.error("Rate limiter error:", error);
                        return true;
                }
        }
}
