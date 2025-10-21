import { createLogger } from "../utils/logger";
import type { AgentContext, AgentTool, AgentToolDescriptor } from "../types/agent-types";

export interface AgentToolResult {
        name: string;
        success: boolean;
        data?: unknown;
        error?: string;
        metadata?: Record<string, unknown>;
}

/**
 * Central registry for all agent tools.
 * Tools can be registered at runtime and looked up by name.
 */
export class AgentToolRegistry {
        private readonly tools = new Map<string, AgentTool>();
        private readonly log = createLogger();

        registerTool(tool: AgentTool): void {
                if (this.tools.has(tool.name)) {
                        this.log.warn({ tool: tool.name }, "Overwriting existing tool registration");
                }
                this.tools.set(tool.name, tool);
        }

        getTool(name: string): AgentTool | undefined {
                return this.tools.get(name);
        }

        listTools(): AgentToolDescriptor[] {
                return Array.from(this.tools.values()).map((tool) => ({
                        name: tool.name,
                        supportedAgents: tool.supportedAgents,
                }));
        }

        getAvailableTools(agentType: string): AgentToolDescriptor[] {
                return this.listTools().filter((tool) => tool.supportedAgents.includes(agentType as never));
        }

        async executeTool(
                name: string,
                params: Record<string, unknown>,
                context: AgentContext,
        ): Promise<AgentToolResult> {
                const tool = this.getTool(name);
                if (!tool) {
                        return {
                                name,
                                success: false,
                                error: `Tool not found: ${name}`,
                        };
                }

                try {
                        const result = await tool.execute(params, context);
                        return { ...result, name, success: true } satisfies AgentToolResult;
                } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        this.log.error({ tool: name, error: message }, "Tool execution failed");
                        return {
                                name,
                                success: false,
                                error: message,
                        } satisfies AgentToolResult;
                }
        }
}
