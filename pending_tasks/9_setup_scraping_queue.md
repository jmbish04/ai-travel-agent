# Task 9: Set Up Scraping Queue

## Objective
Configure Cloudflare Queues for asynchronous scraping task processing, including queue creation, message routing, and integration with both the main Worker and scraping consumer.

## Context
The system needs to decouple web scraping tasks from the main API responses to improve performance and reliability. Queues will handle scraping requests asynchronously, allowing the main Worker to respond quickly while scraping happens in the background.

## Requirements

### 1. Create Queue Infrastructure
- Primary scraping queue for all scraping tasks
- Dead letter queue for failed messages
- Configure queue settings for optimal performance
- Set up monitoring and observability

### 2. Producer Integration
- Integrate queue message sending into main Worker
- Add queue triggering to chat handler
- Implement request prioritization
- Handle queue connection errors

### 3. Consumer Configuration
- Configure scraper Worker as queue consumer
- Set up batch processing parameters
- Implement message acknowledgment
- Handle consumer failures and retries

## Implementation Steps

### 1. Create Queues via Wrangler
```bash
cd travel-agent-worker

# Create primary scraping queue
wrangler queues create scraping-tasks

# Create dead letter queue for failed messages
wrangler queues create scraping-dlq

# Create priority queue for urgent requests
wrangler queues create scraping-priority
```

### 2. Update Main Worker Configuration
Update `travel-agent-worker/wrangler.jsonc`:
```json
{
  "queues": {
    "producers": [
      {
        "binding": "SCRAPING_QUEUE",
        "queue": "scraping-tasks"
      },
      {
        "binding": "PRIORITY_SCRAPING_QUEUE",
        "queue": "scraping-priority"
      }
    ]
  }
}
```

### 3. Update Scraper Worker Configuration
Create/update `travel-agent-scraper/wrangler.toml`:
```toml
[[queues.consumers]]
queue = "scraping-tasks"
max_batch_size = 5
max_batch_timeout = 30
max_retries = 3
dead_letter_queue = "scraping-dlq"

[[queues.consumers]]
queue = "scraping-priority"
max_batch_size = 2
max_batch_timeout = 10
max_retries = 5
```

## Queue Message Design

### 1. Message Structure
```typescript
interface QueueMessage {
  id: string;
  type: 'scrape_request';
  payload: ScrapingRequest;
  metadata: QueueMetadata;
}

interface ScrapingRequest {
  url: string;
  scrapeType: 'hotel' | 'flight' | 'attraction' | 'general';
  options: ScrapeOptions;
  context: RequestContext;
}

interface QueueMetadata {
  priority: 'low' | 'normal' | 'high' | 'urgent';
  scheduledAt: number;
  maxRetries: number;
  timeoutMs: number;
  correlationId: string;
  userId?: string;
  sessionId?: string;
}
```

### 2. Message Routing Logic
```typescript
class QueueRouter {
  routeMessage(request: ScrapingRequest): string {
    // Route based on priority and type
    if (request.metadata.priority === 'urgent') {
      return 'scraping-priority';
    }
    return 'scraping-tasks';
  }
}
```

## Producer Implementation

### 1. Queue Service (`src/core/queue-service.ts`)
```typescript
export class QueueService {
  constructor(
    private scrapingQueue: Queue,
    private priorityQueue: Queue,
    private db: D1Repository
  ) {}

  async enqueueScrapeRequest(request: ScrapingRequest): Promise<string> {
    const messageId = crypto.randomUUID();
    const message: QueueMessage = {
      id: messageId,
      type: 'scrape_request',
      payload: request,
      metadata: {
        ...request.metadata,
        scheduledAt: Date.now(),
        correlationId: messageId
      }
    };

    // Log queue message in D1 for tracking
    await this.db.logQueueMessage({
      queue_name: this.getQueueName(request),
      message_id: messageId,
      status: 'pending',
      payload: JSON.stringify(message)
    });

    // Send to appropriate queue
    const queue = this.selectQueue(request);
    await queue.send(message);

    return messageId;
  }

  private selectQueue(request: ScrapingRequest): Queue {
    return request.metadata.priority === 'urgent'
      ? this.priorityQueue
      : this.scrapingQueue;
  }
}
```

### 2. Integration with Chat Handler
Update `src/core/chat-handler.ts`:
```typescript
export async function handleChat(
  input: ChatInput,
  context: { env: Env; log: Logger; ctx: ExecutionContext }
): Promise<ChatOutput> {
  // ... existing chat logic ...

  // Check if scraping is needed
  if (shouldTriggerScraping(input.message)) {
    const scrapeRequests = identifyScrapeRequests(input.message);

    for (const request of scrapeRequests) {
      await queueService.enqueueScrapeRequest(request);
    }
  }

  // ... rest of chat logic ...
}
```

## Consumer Implementation

### 1. Queue Consumer (`travel-agent-scraper/src/index.ts`)
```typescript
export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    const results = await Promise.allSettled(
      batch.messages.map(message => this.processMessage(message, env))
    );

    // Handle batch results
    results.forEach((result, index) => {
      const message = batch.messages[index];
      if (result.status === 'fulfilled') {
        message.ack();
      } else {
        console.error(`Message ${message.id} failed:`, result.reason);
        message.retry();
      }
    });
  },

  async processMessage(message: Message<QueueMessage>, env: Env): Promise<void> {
    const { id, payload, metadata } = message.body;

    // Update status to processing
    await updateMessageStatus(id, 'processing', env);

    try {
      const result = await performScraping(payload, env);
      await storeScrapingResult(result, env);
      await updateMessageStatus(id, 'completed', env);
    } catch (error) {
      await updateMessageStatus(id, 'failed', env, error.message);
      throw error; // Let queue retry mechanism handle it
    }
  }
};
```

## Error Handling and Monitoring

### 1. Dead Letter Queue Processing
Create monitoring for dead letter queue:
```typescript
// Monitor and alert on DLQ messages
async function processDLQ(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    // Log critical failure
    await logCriticalFailure(message.body, env);

    // Notify administrators
    await notifyFailure(message.body, env);

    // Archive for manual review
    await archiveFailedMessage(message.body, env);

    message.ack(); // Remove from DLQ
  }
}
```

### 2. Queue Health Monitoring
```typescript
interface QueueMetrics {
  pendingMessages: number;
  processingRate: number;
  errorRate: number;
  averageProcessingTime: number;
}

async function getQueueHealth(env: Env): Promise<QueueMetrics> {
  // Query D1 for queue statistics
  return await db.getQueueMetrics();
}
```

## Queue Configuration Optimization

### 1. Batch Size Tuning
- `max_batch_size: 5` for standard queue (balance throughput/latency)
- `max_batch_size: 2` for priority queue (lower latency)
- Monitor and adjust based on processing times

### 2. Timeout Configuration
- `max_batch_timeout: 30s` for standard (allow batching)
- `max_batch_timeout: 10s` for priority (faster response)
- `max_retries: 3` with exponential backoff

### 3. Scaling Considerations
- Queue consumers scale automatically
- Monitor queue depth and processing lag
- Implement circuit breakers for downstream services

## Files to Create/Modify

### New Files:
- `src/core/queue-service.ts` - Queue operations
- `src/utils/queue-router.ts` - Message routing logic
- `src/types/queue-messages.ts` - Queue message types

### Modified Files:
- `src/core/chat-handler.ts` - Add queue integration
- `src/index.ts` - Initialize queue service
- `wrangler.jsonc` - Queue producer configuration

### Scraper Worker Files:
- `travel-agent-scraper/src/index.ts` - Queue consumer
- `travel-agent-scraper/wrangler.toml` - Consumer configuration

## Success Criteria
- [ ] Queues created and configured
- [ ] Message production from main Worker working
- [ ] Message consumption by scraper Worker working
- [ ] Dead letter queue handling implemented
- [ ] Queue monitoring and metrics in place
- [ ] Error handling and retry logic working
- [ ] Performance optimization applied
- [ ] Integration tests passing

## Testing Requirements
- Unit tests for queue service
- Integration tests for producer/consumer
- Error scenario testing (queue unavailable, message failures)
- Load testing with high message volumes
- Dead letter queue processing tests
- Performance benchmarks

## Monitoring and Observability
- Queue depth monitoring
- Message processing latency
- Error rates and retry patterns
- Dead letter queue alerts
- Performance metrics collection

## Dependencies
- Cloudflare Queues feature enabled
- Scraper Worker implementation (Task 8)
- D1 database for queue logging
- Main Worker chat handler integration
