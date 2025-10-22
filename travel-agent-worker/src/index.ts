import type { MessageBatch } from "@cloudflare/workers-types";
import { D1Repository } from "./core/d1-repository";
import { handleChat } from "./core/chat-handler";
import { KVService } from "./core/kv-service";
import { QueueService } from "./core/queue-service";
import { R2StorageService } from "./core/r2-storage";
import { SessionKvStore } from "./core/session-kv-store";
import { Router } from "./router";
import { ChatInput, ChatOutput } from "./schemas/chat";
import type { ScrapedMetadata } from "./types/database";
import type { WorkerEnv } from "./types/env";
import type { CachePointer, R2BucketTarget } from "./types/r2";
import { createLogger } from "./utils/logger";
import { RateLimiter } from "./utils/rate-limiter";
import { decodeBase64 } from "./utils/serialization";
import { handleQueue } from "./scraping/handler";
import type { QueueMessage } from "./scraping/types/messages";

const CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
        async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
                const url = new URL(request.url);
                const log = createLogger();

                if (request.method === "OPTIONS") {
                        return new Response(null, { headers: CORS_HEADERS });
                }

                const router = new Router();
                const rateLimiterKv = new KVService(env.CACHE, { prefix: "rate_limit:" });
                const rateLimiter = new RateLimiter(rateLimiterKv, {
                        windowSizeSeconds: 60,
                        maxRequests: 120,
                });
                const cacheMetadataKv = new KVService(env.CACHE, { prefix: "cache_pointer:" });
                const sessionKv = new KVService(env.SESSIONS, { prefix: "session:" });
                const sessionStore = new SessionKvStore(sessionKv);
                const r2Storage = new R2StorageService({
                        scrapedData: env.SCRAPED_DATA,
                        userUploads: env.USER_UPLOADS,
                        cache: env.CACHE_BUCKET,
                });
                const repository = new D1Repository(env.DB);
                const queueService = new QueueService(
                        {
                                standard: env.SCRAPING_QUEUE,
                                priority: env.PRIORITY_SCRAPING_QUEUE,
                        },
                        repository,
                );

                if (url.pathname !== "/healthz") {
                        const clientIp = request.headers.get("CF-Connecting-IP") ?? "anonymous";
                        const allowed = await rateLimiter.acquire(clientIp);
                        if (!allowed) {
                                log.warn({ path: url.pathname, ip: clientIp }, "Rate limit exceeded");
                                return new Response(
                                        JSON.stringify({
                                                error: "rate_limited",
                                                message: "Too many requests. Please try again later.",
                                        }),
                                        {
                                                status: 429,
                                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                        },
                                );
                        }
                }

                try {
                        router.post("/chat", async (req: Request) => {
                                const body = await req.json();
                                const parsed = ChatInput.safeParse(body);

                                if (!parsed.success) {
                                        return new Response(
                                                JSON.stringify({ error: parsed.error.flatten() }),
                                                {
                                                        status: 400,
                                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                                },
                                        );
                                }

                                const t0 = Date.now();
                                const result = await handleChat(parsed.data, {
                                        env,
                                        log,
                                        ctx,
                                        sessionStore,
                                        queueService,
                                });
                                const latency = Date.now() - t0;
                                log.info({ latency }, "Chat request completed");

                                return new Response(JSON.stringify(ChatOutput.parse(result)), {
                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                });
                        });

                        router.get("/healthz", async () => {
                                const health = {
                                        ok: true,
                                        timestamp: new Date().toISOString(),
                                        services: {
                                                kv: "ok",
                                                d1: "ok",
                                                r2: "ok",
                                        },
                                };

                                try {
                                        await rateLimiterKv.set("health-check", { ok: true }, 60);
                                        await rateLimiterKv.get("health-check");
                                } catch {
                                        health.services.kv = "degraded";
                                        health.ok = false;
                                }

                                return new Response(JSON.stringify(health), {
                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                });
                        });

                        router.get("/metrics", async () => {
                                const metrics = {
                                        requests: 0,
                                        errors: 0,
                                        latency: { avg: 0, p95: 0, p99: 0 },
                                };

                                return new Response(JSON.stringify(metrics), {
                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                });
                        });

                        router.post("/scraped-data", async (req: Request) => {
                                const payload = await req.json();
                                const requiredFields = ["url", "scrapeType", "content"] as const;
                                for (const field of requiredFields) {
                                        if (!payload[field]) {
                                                return new Response(
                                                        JSON.stringify({
                                                                error: "validation_error",
                                                                message: `Missing required field: ${field}`,
                                                        }),
                                                        {
                                                                status: 400,
                                                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                                        },
                                                );
                                        }
                                }

                                const bytes = decodeBase64(payload.content);
                                const r2Metadata = payload.r2Metadata
                                        ? Object.fromEntries(
                                                  Object.entries(payload.r2Metadata as Record<string, unknown>).map(
                                                          ([key, value]) => [key, String(value)],
                                                  ),
                                          )
                                        : undefined;

                                const stored = await r2Storage.storeScrapedContent({
                                        key: payload.key,
                                        data: bytes,
                                        size: bytes.byteLength,
                                        contentType: payload.contentType ?? "text/html",
                                        metadata: r2Metadata,
                                });

                                const metadata: ScrapedMetadata = {
                                        ...(payload.metadata ?? {}),
                                        size: stored.size,
                                        contentType: stored.contentType,
                                        bucket: stored.bucket,
                                };

                                const recordId = await repository.addScrapedDataRecord({
                                        id: payload.id,
                                        url: payload.url,
                                        scrapeType: payload.scrapeType,
                                        r2Key: stored.key,
                                        metadata,
                                        userId: payload.userId,
                                        sessionId: payload.sessionId,
                                });

                                return new Response(
                                        JSON.stringify({
                                                id: recordId,
                                                r2Key: stored.key,
                                                bucket: stored.bucket,
                                                size: stored.size,
                                        }),
                                        {
                                                status: 201,
                                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                        },
                                );
                        });

                        router.post("/uploads", async (req: Request) => {
                                const payload = await req.json();
                                if (!payload.data) {
                                        return new Response(
                                                JSON.stringify({
                                                        error: "validation_error",
                                                        message: "Missing data field",
                                                }),
                                                {
                                                        status: 400,
                                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                                },
                                        );
                                }

                                const bytes = decodeBase64(payload.data);
                                const r2Metadata = payload.metadata
                                        ? Object.fromEntries(
                                                  Object.entries(payload.metadata as Record<string, unknown>).map(
                                                          ([key, value]) => [key, String(value)],
                                                  ),
                                          )
                                        : undefined;

                                const stored = await r2Storage.storeUserUpload({
                                        key: payload.key,
                                        data: bytes,
                                        size: bytes.byteLength,
                                        contentType: payload.contentType ?? "application/octet-stream",
                                        filename: payload.filename,
                                        metadata: r2Metadata,
                                });

                                return new Response(JSON.stringify(stored), {
                                        status: 201,
                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                });
                        });

                        router.get("/storage", async (req: Request) => {
                                const { searchParams } = new URL(req.url);
                                const bucketParam = searchParams.get("bucket");
                                const key = searchParams.get("key");

                                const bucketMap: Record<string, R2BucketTarget> = {
                                        scraped: "scrapedData",
                                        uploads: "userUploads",
                                        cache: "cache",
                                };

                                if (!bucketParam || !key || !bucketMap[bucketParam]) {
                                        return new Response(
                                                JSON.stringify({
                                                        error: "validation_error",
                                                        message: "bucket and key query parameters are required",
                                                }),
                                                {
                                                        status: 400,
                                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                                },
                                        );
                                }

                                const result = await r2Storage.getObject(bucketMap[bucketParam], key);
                                if (!result) {
                                        return new Response(JSON.stringify({ error: "not_found" }), {
                                                status: 404,
                                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                        });
                                }

                                const headers: HeadersInit = { ...CORS_HEADERS };
                                if (result.contentType) {
                                        headers["Content-Type"] = result.contentType;
                                }
                                if (result.etag) {
                                        headers["ETag"] = result.etag;
                                }

                                return new Response(result.body, { headers });
                        });

                        router.post("/cache", async (req: Request) => {
                                const payload = await req.json();
                                if (!payload.data) {
                                        return new Response(
                                                JSON.stringify({
                                                        error: "validation_error",
                                                        message: "Missing data field",
                                                }),
                                                {
                                                        status: 400,
                                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                                },
                                        );
                                }

                                const cacheKey: string = payload.key ?? crypto.randomUUID();
                                const bytes = decodeBase64(payload.data);
                                const r2Metadata = payload.metadata
                                        ? Object.fromEntries(
                                                  Object.entries(payload.metadata as Record<string, unknown>).map(
                                                          ([key, value]) => [key, String(value)],
                                                  ),
                                          )
                                        : undefined;

                                const stored = await r2Storage.storeCacheEntry({
                                        key: cacheKey,
                                        data: bytes,
                                        size: bytes.byteLength,
                                        contentType: payload.contentType,
                                        metadata: r2Metadata,
                                        ttlSeconds: payload.ttlSeconds,
                                });

                                const pointer = await r2Storage.buildCachePointer(stored, payload.ttlSeconds);
                                await cacheMetadataKv.set<CachePointer>(cacheKey, pointer, payload.ttlSeconds);

                                return new Response(
                                        JSON.stringify({ cacheKey, pointer }),
                                        {
                                                status: 201,
                                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                        },
                                );
                        });

                        router.get("/cache", async (req: Request) => {
                                const { searchParams } = new URL(req.url);
                                const cacheKey = searchParams.get("key");
                                if (!cacheKey) {
                                        return new Response(
                                                JSON.stringify({
                                                        error: "validation_error",
                                                        message: "key query parameter is required",
                                                }),
                                                {
                                                        status: 400,
                                                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                                },
                                        );
                                }

                                const pointer = await cacheMetadataKv.get<CachePointer>(cacheKey);
                                if (!pointer) {
                                        return new Response(JSON.stringify({ error: "not_found" }), {
                                                status: 404,
                                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                        });
                                }

                                const result = await r2Storage.getObject(pointer.bucket, pointer.key);
                                if (!result) {
                                        return new Response(JSON.stringify({ error: "not_found" }), {
                                                status: 404,
                                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                                        });
                                }

                                const headers: HeadersInit = { ...CORS_HEADERS };
                                if (result.contentType) {
                                        headers["Content-Type"] = result.contentType;
                                }
                                if (result.etag) {
                                        headers["ETag"] = result.etag;
                                }

                                return new Response(result.body, { headers });
                        });

                        router.get("/", async () => {
                                const html = `<!DOCTYPE html>
<html>
<head>
        <title>Travel Agent Backend</title>
</head>
<body>
        <h1>Travel Agent Backend - Cloudflare Workers</h1>
        <p>Backend API is running on Cloudflare Workers</p>
        <ul>
                <li><a href="/healthz">Health Check</a></li>
                <li><a href="/metrics">Metrics</a></li>
        </ul>
</body>
</html>`;

                                return new Response(html, {
                                        headers: { "Content-Type": "text/html", ...CORS_HEADERS },
                                });
                        });

                        const routed = await router.handle(request);
                        if (routed) {
                                return routed;
                        }

                        return new Response(JSON.stringify({ error: "not_found" }), {
                                status: 404,
                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                        });
                } catch (error) {
                        log.error({ error }, "Request handler failed");
                        return new Response(JSON.stringify({ error: "internal_error" }), {
                                status: 500,
                                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                        });
                }
        },

        async queue(
                batch: MessageBatch<QueueMessage>,
                env: WorkerEnv,
                _ctx: ExecutionContext,
        ): Promise<void> {
                await handleQueue(batch, env);
        },
} satisfies ExportedHandler<WorkerEnv>;
