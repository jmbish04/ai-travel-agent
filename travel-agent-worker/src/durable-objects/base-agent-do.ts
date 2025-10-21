import { AgentToolRegistry } from "../tools/agent-tool-registry";
import { WeatherTool } from "../tools/weather-tool";
import { AmadeusFlightTool, AmadeusHotelTool } from "../tools/amadeus-tool";
import { WebSearchTool } from "../tools/search-tool";
import { AttractionsTool } from "../tools/attractions-tool";
import type { AgentContext, AgentMessage, AgentResponse, AgentState } from "../types/agent-types";
import { MetaOrchestratorAgent } from "../agents/meta-orchestrator";
import { createLogger } from "../utils/logger";

export abstract class BaseAgentDO implements DurableObject {
        protected readonly storage: DurableObjectStorage;
        protected readonly env: Env;
        protected readonly tools: AgentToolRegistry;
        protected readonly log = createLogger();

        constructor(state: DurableObjectState, env: Env) {
                this.storage = state.storage;
                this.env = env;
                this.tools = new AgentToolRegistry();
                this.registerDefaultTools();
        }

        abstract handleMessage(message: AgentMessage): Promise<AgentResponse>;

        abstract getState(): Promise<AgentState>;

        abstract updateState(updates: Partial<AgentState>): Promise<void>;

        protected registerDefaultTools(): void {
                this.tools.registerTool(new WeatherTool());
                this.tools.registerTool(new AmadeusFlightTool());
                this.tools.registerTool(new AmadeusHotelTool());
                this.tools.registerTool(new WebSearchTool());
                this.tools.registerTool(new AttractionsTool());
        }

        protected createMetaAgent(): MetaOrchestratorAgent {
                return new MetaOrchestratorAgent(this.storage, this.env, this.tools);
        }

        async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);

                if (request.method === "POST" && url.pathname === "/message") {
                        const message = (await request.json()) as AgentMessage;
                        const response = await this.handleMessage(message);
                        return new Response(JSON.stringify(response), {
                                headers: { "Content-Type": "application/json" },
                        });
                }

                if (request.method === "GET" && url.pathname === "/state") {
                        const state = await this.getState();
                        return new Response(JSON.stringify(state), {
                                headers: { "Content-Type": "application/json" },
                        });
                }

                if (request.method === "GET" && url.pathname === "/health") {
                        return new Response(JSON.stringify({ status: "healthy" }), {
                                headers: { "Content-Type": "application/json" },
                        });
                }

                return new Response("Not Found", { status: 404 });
        }

        protected buildAgentContext(message: AgentMessage): AgentContext {
                const context = message.context;
                return {
                        sessionId: context?.sessionId ?? "unknown",
                        threadId: context?.threadId ?? "unknown",
                        userId: context?.userId,
                        locale: context?.locale,
                        timezone: context?.timezone,
                        metadata: context?.metadata,
                } satisfies AgentContext;
        }
}
