import type { AgentContext, AgentTool } from "../types/agent-types";
import type { AgentToolResult } from "./agent-tool-registry";

interface SearchParams {
        query: string;
        limit?: number;
        locale?: string;
}

export class WebSearchTool implements AgentTool {
        readonly name = "search";
        readonly supportedAgents = ["destination", "meta", "attractions"] as const;

        async execute(params: Record<string, unknown>, context: AgentContext): Promise<AgentToolResult> {
                const { query, limit = 5, locale } = params as SearchParams;
                return {
                        name: this.name,
                        success: true,
                        data: {
                                query,
                                limit,
                                locale: locale ?? context.locale,
                                results: [],
                        },
                        metadata: {
                                context,
                                provider: "web-search",
                        },
                } satisfies AgentToolResult;
        }
}
