import type { AgentMessage, AgentResponse, ToolResult } from "../types/durable-object-types";
import type { WorkerEnv } from "../types/env";

export type AgentToolHandler = (
        parameters: Record<string, unknown>,
        env: WorkerEnv,
) => Promise<unknown> | unknown;

/**
 * Registry for lightweight tool handlers used by the TravelAgentDO.
 */
export class AgentToolRegistry {
        private readonly tools = new Map<string, AgentToolHandler>();

        constructor(private readonly env: WorkerEnv) {}

        registerTool(name: string, handler: AgentToolHandler): void {
                this.tools.set(name, handler);
        }

        hasTool(name: string): boolean {
                return this.tools.has(name);
        }

        async executeTool(name: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
                const handler = this.tools.get(name);
                if (!handler) {
                        throw new Error(`Tool not found: ${name}`);
                }

                return handler(parameters, this.env);
        }
}

/**
 * Utility helper to create a consistent AgentResponse payload.
 */
export function createAgentResponse<T>(
        input: Partial<AgentResponse<T>> & { type: string; content: T },
): AgentResponse<T> {
        return {
                id: input.id ?? crypto.randomUUID(),
                type: input.type,
                content: input.content,
                status: input.status ?? "ok",
                metadata: input.metadata ?? {},
                error: input.error,
                confidence: input.confidence,
                sources: input.sources,
        };
}

export function createToolResultsSummary(results: ToolResult[]): Record<string, unknown> {
        const summary: Record<string, unknown> = {
                total: results.length,
                succeeded: results.filter((result) => result.success).length,
                failed: results.filter((result) => !result.success).length,
        };

        const failures = results
                .filter((result) => !result.success)
                .map((result) => ({ name: result.toolCall.name, error: result.error }));

        if (failures.length > 0) {
                summary.failures = failures;
        }

        return summary;
}

/**
 * Parses an incoming request body as an AgentMessage.
 */
export async function parseAgentMessageRequest(request: Request): Promise<AgentMessage> {
        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
                throw new Error("Expected application/json content type");
        }

        const message = (await request.json()) as AgentMessage | null;
        if (!message || typeof message.type !== "string") {
                throw new Error("Invalid agent message payload");
        }

        return {
                ...message,
                id: message.id ?? crypto.randomUUID(),
        };
}

export function asAgentResponse(response: Response): Promise<AgentResponse> {
        return response.json() as Promise<AgentResponse>;
}
