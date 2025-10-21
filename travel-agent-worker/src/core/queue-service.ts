import { QueueRouter } from "../utils/queue-router";
import type { D1Repository } from "./d1-repository";
import type { QueueMessage, ScrapingRequest } from "../types/queue-messages";

interface QueueBindings {
        standard: Queue;
        priority: Queue;
}

export class QueueService {
        private readonly router: QueueRouter;

        constructor(
                private readonly queues: QueueBindings,
                private readonly repository: D1Repository,
                router?: QueueRouter,
        ) {
                this.router = router ?? new QueueRouter();
        }

        async enqueueScrapeRequest(request: ScrapingRequest): Promise<string> {
                const messageId = crypto.randomUUID();
                const metadata = {
                        priority: request.metadata.priority ?? "normal",
                        scheduledAt: request.metadata.scheduledAt ?? Date.now(),
                        maxRetries: request.metadata.maxRetries ?? 3,
                        timeoutMs: request.metadata.timeoutMs ?? 30_000,
                        correlationId: request.metadata.correlationId || messageId,
                        userId: request.metadata.userId ?? request.context?.userId,
                        sessionId: request.metadata.sessionId ?? request.context?.sessionId,
                };
                const queueMessage: QueueMessage = {
                        id: messageId,
                        type: "scrape_request",
                        payload: {
                                ...request,
                                id: request.id ?? messageId,
                                metadata,
                        },
                        metadata,
                };

                await this.repository.logQueueMessage({
                        queue_name: this.resolveQueueName(queueMessage),
                        message_id: queueMessage.id,
                        status: "pending",
                        payload: JSON.stringify(queueMessage),
                        error_message: null,
                        retry_count: 0,
                        processed_at: null,
                });

                await this.selectQueue(queueMessage).send(queueMessage);

                return messageId;
        }

        private selectQueue(message: QueueMessage): Queue {
                return this.router.selectQueue(message.payload) === "priority"
                        ? this.queues.priority
                        : this.queues.standard;
        }

        private resolveQueueName(message: QueueMessage): string {
                return this.router.selectQueue(message.payload) === "priority"
                        ? "scraping-priority"
                        : "scraping-tasks";
        }

        async updateQueueStatus(
                messageId: string,
                status: "processing" | "completed" | "failed",
                errorMessage?: string,
        ): Promise<void> {
                await this.repository.updateQueueMessageStatus(messageId, status, errorMessage);
        }
}
