/**
 * Rate limiter using Cloudflare KV
 */
export class RateLimiter {
	private kv: KVNamespace;
	private windowSizeSeconds: number;
	private maxRequests: number;

	constructor(kv: KVNamespace, windowSizeSeconds = 60, maxRequests = 100) {
		this.kv = kv;
		this.windowSizeSeconds = windowSizeSeconds;
		this.maxRequests = maxRequests;
	}

	async acquire(key: string): Promise<boolean> {
		const now = Math.floor(Date.now() / 1000);
		const windowStart = now - this.windowSizeSeconds;

		try {
			// Get current request count for this key
			const countKey = `rate_limit:${key}`;
			const requestsStr = await this.kv.get(countKey);
			const requests = requestsStr ? JSON.parse(requestsStr) : [];

			// Filter out old requests
			const validRequests = requests.filter((timestamp: number) => timestamp > windowStart);

			// Check if we're over the limit
			if (validRequests.length >= this.maxRequests) {
				return false;
			}

			// Add current request and store
			validRequests.push(now);
			await this.kv.put(countKey, JSON.stringify(validRequests), {
				expirationTtl: this.windowSizeSeconds + 10
			});

			return true;
		} catch (error) {
			// If KV is down, allow the request (fail open)
			console.error('Rate limiter error:', error);
			return true;
		}
	}
}
