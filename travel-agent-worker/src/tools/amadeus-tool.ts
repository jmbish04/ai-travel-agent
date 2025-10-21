import type { AgentContext, AgentTool } from "../types/agent-types";
import type { AgentToolResult } from "./agent-tool-registry";

interface FlightCriteria {
        origin?: string;
        destination: string;
        departureDate?: string;
}

interface HotelCriteria {
        destination: string;
        checkIn?: string;
        checkOut?: string;
}

export class AmadeusFlightTool implements AgentTool {
        readonly name = "flights";
        readonly supportedAgents = ["booking", "meta"] as const;

        async execute(params: Record<string, unknown>, context: AgentContext): Promise<AgentToolResult> {
                const criteria = params as FlightCriteria;
                return {
                        name: this.name,
                        success: true,
                        data: {
                                flights: [],
                                criteria,
                        },
                        metadata: {
                                context,
                                provider: "amadeus",
                                type: "flight",
                        },
                } satisfies AgentToolResult;
        }
}

export class AmadeusHotelTool implements AgentTool {
        readonly name = "hotels";
        readonly supportedAgents = ["booking", "meta"] as const;

        async execute(params: Record<string, unknown>, context: AgentContext): Promise<AgentToolResult> {
                const criteria = params as HotelCriteria;
                return {
                        name: this.name,
                        success: true,
                        data: {
                                hotels: [],
                                criteria,
                        },
                        metadata: {
                                context,
                                provider: "amadeus",
                                type: "hotel",
                        },
                } satisfies AgentToolResult;
        }
}
