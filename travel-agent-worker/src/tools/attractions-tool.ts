import type { AgentContext, AgentTool } from "../types/agent-types";
import type { AgentToolResult } from "./agent-tool-registry";

interface AttractionsParams {
        destination: string;
        interests?: string[];
}

export class AttractionsTool implements AgentTool {
        readonly name = "attractions";
        readonly supportedAgents = ["attractions", "meta", "destination"] as const;

        async execute(params: Record<string, unknown>, context: AgentContext): Promise<AgentToolResult> {
                const { destination, interests = [] } = params as AttractionsParams;
                return {
                        name: this.name,
                        success: true,
                        data: {
                                destination,
                                interests,
                                recommendations: [],
                        },
                        metadata: {
                                context,
                                provider: "knowledge-base",
                        },
                } satisfies AgentToolResult;
        }
}
