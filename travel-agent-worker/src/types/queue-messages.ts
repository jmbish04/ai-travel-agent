export type ScrapeType = 'hotel' | 'flight' | 'attraction' | 'general';

export type ScrapePriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ScrapeOptions {
        waitFor?: string;
        extractImages?: boolean;
        extractReviews?: boolean;
        maxPages?: number;
        waitForSelectors?: string[];
        timeoutMs?: number;
}

export interface ScrapingRequest {
        id?: string;
        url: string;
        scrapeType: ScrapeType;
        options?: ScrapeOptions;
        context?: RequestContext;
        metadata: QueueMetadata;
}

export interface RequestContext {
        userId?: string;
        sessionId?: string;
        threadId?: string;
        requestedAt?: number;
}

export interface QueueMetadata {
        priority: ScrapePriority;
        scheduledAt: number;
        maxRetries: number;
        timeoutMs: number;
        correlationId: string;
        userId?: string;
        sessionId?: string;
}

export interface QueueMessage {
        id: string;
        type: 'scrape_request';
        payload: ScrapingRequest;
        metadata: QueueMetadata;
}
