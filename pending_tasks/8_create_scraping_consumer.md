# Task 8: Create Scraping Consumer Worker

## Objective
Create a dedicated Cloudflare Worker for processing web scraping tasks using Browser Rendering, designed to consume messages from Cloudflare Queues.

## Context
The original system uses `crawlee` and `playwright` for web scraping. We need to create a separate Worker that uses Cloudflare's Browser Rendering service to perform scraping tasks asynchronously via Queue messages.

## Requirements

### 1. Create Separate Worker Project
Create a new Worker specifically for scraping:
- `travel-agent-scraper/` - New Worker directory
- Dedicated `wrangler.toml` configuration
- Browser Rendering binding
- Queue consumer configuration

### 2. Browser Rendering Integration
- Use `@cloudflare/playwright` for browser automation
- Implement headless browser control
- Handle dynamic content loading
- Extract structured data from web pages

### 3. Queue Message Processing
- Consume messages from scraping queue
- Process scraping requests asynchronously
- Handle retry logic and error scenarios
- Store results in R2 and metadata in D1

## Implementation Steps

### 1. Create New Worker Project
```bash
mkdir travel-agent-scraper
cd travel-agent-scraper
npm init cloudflare@latest . --type hello-world
```

### 2. Configure Browser Rendering
Update `wrangler.toml`:
```toml
name = "travel-agent-scraper"
main = "src/index.ts"

[[browser]]
binding = "BROWSER"

[[queues.consumers]]
queue = "scraping-tasks"
max_batch_size = 5
max_batch_timeout = 30
max_retries = 3
```

### 3. Install Dependencies
```bash
npm install @cloudflare/playwright
npm install zod  # For message validation
```

## File Structure
```
travel-agent-scraper/
├── src/
│   ├── index.ts              # Queue consumer entry point
│   ├── browser-controller.ts # Browser automation logic
│   ├── scrapers/
│   │   ├── hotel-scraper.ts  # Hotel-specific scraping
│   │   ├── flight-scraper.ts # Flight-specific scraping
│   │   └── base-scraper.ts   # Common scraping functionality
│   ├── types/
│   │   └── messages.ts       # Queue message types
│   └── utils/
│       ├── url-validation.ts # URL safety validation
│       └── data-extraction.ts # Data parsing utilities
├── wrangler.toml
└── package.json
```

## Key Components to Implement

### 1. Queue Message Handler (`src/index.ts`)
```typescript
export default {
  async queue(batch: MessageBatch<ScrapingMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processScrapeRequest(message.body, env);
        message.ack();
      } catch (error) {
        console.error('Scraping failed:', error);
        message.retry();
      }
    }
  }
};
```

### 2. Browser Controller (`src/browser-controller.ts`)
```typescript
class BrowserController {
  constructor(private browser: Browser) {}

  async scrapeUrl(url: string, options: ScrapeOptions): Promise<ScrapedData> {
    const session = await this.browser.connect();
    const page = await session.newPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      return await this.extractData(page, options);
    } finally {
      await page.close();
      await session.close();
    }
  }
}
```

### 3. Specialized Scrapers

#### Hotel Scraper (`src/scrapers/hotel-scraper.ts`)
- Extract hotel information (name, rating, price, amenities)
- Handle booking site variations
- Extract images and reviews
- Parse availability data

#### Flight Scraper (`src/scrapers/flight-scraper.ts`)
- Extract flight information (routes, times, prices)
- Handle airline website variations
- Parse schedules and availability
- Extract booking options

### 4. Data Storage Integration
- Store scraped HTML/content in R2
- Store structured metadata in D1
- Cache frequently accessed data in KV
- Generate unique IDs for scraped content

## Message Format
```typescript
interface ScrapingMessage {
  id: string;
  url: string;
  type: 'hotel' | 'flight' | 'attraction' | 'general';
  options: {
    waitFor?: string;          // CSS selector to wait for
    extractImages?: boolean;
    extractReviews?: boolean;
    maxPages?: number;
  };
  metadata: {
    userId?: string;
    sessionId?: string;
    requestedAt: number;
    priority: 'low' | 'normal' | 'high';
  };
}
```

## Error Handling Strategy

### 1. Retry Logic
- Network timeouts: Retry with exponential backoff
- Browser crashes: Restart browser session
- Page load failures: Try alternative selectors
- Rate limiting: Respect robots.txt and implement delays

### 2. Fallback Mechanisms
- Primary: Browser Rendering
- Fallback: HTTP fetch for static content
- Emergency: Return cached data if available

### 3. Error Classification
- Retryable: Network errors, timeouts
- Non-retryable: Invalid URLs, access denied
- Partial: Some data extracted, log warnings

## Security Considerations

### 1. URL Validation
- Whitelist allowed domains
- Validate URL format and safety
- Check for malicious content
- Respect robots.txt

### 2. Data Sanitization
- Clean extracted HTML
- Validate extracted data
- Remove tracking scripts
- Sanitize user inputs

## Performance Optimization

### 1. Browser Resource Management
- Reuse browser sessions when possible
- Implement session pooling
- Set appropriate timeouts
- Clean up resources properly

### 2. Scraping Efficiency
- Parallel processing of batch messages
- Intelligent waiting strategies
- Selective data extraction
- Compression of stored data

## Files to Create

### Core Files:
- `src/index.ts` - Main queue consumer
- `src/browser-controller.ts` - Browser automation
- `src/scrapers/base-scraper.ts` - Common scraping logic
- `src/types/messages.ts` - Message type definitions

### Scraper Implementations:
- `src/scrapers/hotel-scraper.ts`
- `src/scrapers/flight-scraper.ts`
- `src/scrapers/attraction-scraper.ts`

### Utilities:
- `src/utils/url-validation.ts`
- `src/utils/data-extraction.ts`
- `src/utils/storage-helpers.ts`

## Success Criteria
- [ ] Separate scraper Worker created and configured
- [ ] Browser Rendering integration working
- [ ] Queue message consumption implemented
- [ ] Specialized scrapers for different content types
- [ ] Data storage integration (R2 + D1) working
- [ ] Error handling and retry logic implemented
- [ ] Security validations in place
- [ ] Performance optimizations applied

## Testing Requirements
- Unit tests for scraper logic
- Integration tests with Browser Rendering
- Queue message processing tests
- Error scenario testing
- Performance benchmarks
- Security validation tests

## Dependencies
- Cloudflare Browser Rendering access
- R2 buckets (Task 5)
- D1 database schema (already done)
- Queue setup (Task 9)
- Main Worker integration points

## Configuration Requirements
- Browser Rendering enabled on Cloudflare account
- Queue permissions configured
- R2 and D1 access permissions
- Environment variables for external APIs
