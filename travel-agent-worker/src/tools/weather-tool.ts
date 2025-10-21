import type { AgentContext, AgentTool } from "../types/agent-types";
import type { AgentToolResult } from "./agent-tool-registry";

interface WeatherToolParams {
        destination: string;
        dates?: { start?: string; end?: string };
}

export class WeatherTool implements AgentTool {
        readonly name = "weather";
        readonly supportedAgents = ["weather", "meta"] as const;

        async execute(params: Record<string, unknown>, context: AgentContext): Promise<AgentToolResult> {
                const { destination, dates } = params as WeatherToolParams;
                const forecast = {
                        destination,
                        dates: dates ?? null,
                        summary: "Sunny with a chance of modular refactors.",
                        highTempC: 24,
                        lowTempC: 16,
                };

                return {
                        name: this.name,
                        success: true,
                        data: forecast,
                        metadata: {
                                context,
                                generatedAt: Date.now(),
                        },
                } satisfies AgentToolResult;
        }
}
