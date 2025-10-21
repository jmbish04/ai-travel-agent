/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { handleChat } from "./core/chat-handler";
import { Router } from "./router";
import { ChatInput, ChatOutput } from "./schemas/chat";
import { createLogger } from "./utils/logger";
import { RateLimiter } from "./utils/rate-limiter";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const log = createLogger();

		// Initialize router
		const router = new Router();

		// CORS headers
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		};

		// Handle CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// Rate limiting (skip for health checks)
		if (url.pathname !== "/healthz") {
			const rateLimiter = new RateLimiter(env.CACHE);
			const clientIp = request.headers.get("CF-Connecting-IP") || "anonymous";

			if (!(await rateLimiter.acquire(clientIp))) {
				log.warn({ path: url.pathname, ip: clientIp }, "Rate limit exceeded");
				return new Response(
					JSON.stringify({
						error: "Rate limit exceeded",
						message: "Too many requests. Please try again later.",
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json", ...corsHeaders },
					},
				);
			}
		}

		try {
			// Route handlers
			router.post("/chat", async (request: Request) => {
				try {
					const body = await request.json();
					const parsed = ChatInput.safeParse(body);

					if (!parsed.success) {
						return new Response(
							JSON.stringify({ error: parsed.error.flatten() }),
							{
								status: 400,
								headers: { "Content-Type": "application/json", ...corsHeaders },
							},
						);
					}

					const t0 = Date.now();
					const result = await handleChat(parsed.data, { env, log, ctx });

					// Track e2e latency
					const latency = Date.now() - t0;
					log.info({ latency }, "Chat request completed");

					return new Response(JSON.stringify(ChatOutput.parse(result)), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
				} catch (error) {
					log.error({ error }, "Chat request failed");
					return new Response(JSON.stringify({ error: "internal_error" }), {
						status: 500,
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
				}
			});

			router.get("/healthz", async () => {
				// Check various service health
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
					// Quick KV health check
					await env.CACHE.put("health-check", "ok", { expirationTtl: 60 });
					await env.CACHE.get("health-check");
				} catch {
					health.services.kv = "degraded";
					health.ok = false;
				}

				return new Response(JSON.stringify(health), {
					headers: { "Content-Type": "application/json", ...corsHeaders },
				});
			});

			router.get("/metrics", async (request: Request) => {
				// Placeholder for metrics endpoint
				// TODO: Implement metrics collection compatible with existing system
				const metrics = {
					requests: 0,
					errors: 0,
					latency: { avg: 0, p95: 0, p99: 0 },
				};

				return new Response(JSON.stringify(metrics), {
					headers: { "Content-Type": "application/json", ...corsHeaders },
				});
			});

			// Static asset serving (placeholder)
			router.get("/", async () => {
				const html = `
<!DOCTYPE html>
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
					headers: { "Content-Type": "text/html", ...corsHeaders },
				});
			});

			// Handle the request
			const response = await router.handle(request);
			if (response) {
				return response;
			}

			// 404 for unmatched routes
			return new Response(JSON.stringify({ error: "Not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json", ...corsHeaders },
			});
		} catch (error) {
			log.error({ error }, "Request handler failed");
			return new Response(JSON.stringify({ error: "Internal server error" }), {
				status: 500,
				headers: { "Content-Type": "application/json", ...corsHeaders },
			});
		}
	},
} satisfies ExportedHandler<Env>;
