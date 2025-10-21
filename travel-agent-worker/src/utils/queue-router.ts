import type { ScrapingRequest } from "../types/queue-messages";

export class QueueRouter {
        constructor(private readonly priorityTypes: Set<ScrapingRequest["scrapeType"]> = new Set(["flight"])) {}

        selectQueue(request: ScrapingRequest): "priority" | "standard" {
                if (request.metadata.priority === "urgent") {
                        return "priority";
                }

                if (request.metadata.priority === "high" && request.metadata.maxRetries > 3) {
                        return "priority";
                }

                if (this.priorityTypes.has(request.scrapeType) && request.metadata.priority !== "low") {
                        return "priority";
                }

                return "standard";
        }
}
