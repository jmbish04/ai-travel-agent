# Task 10: Rewrite Scraping Logic for Cloudflare Browser Rendering

## Objective
Migrate the existing scraping logic from `crawlee` and `playwright` to Cloudflare's Browser Rendering service, adapting the scraping strategies for the edge computing environment.

## Context
The original system in `root/src/tools/` uses `crawlee` and `playwright` for web scraping. We need to analyze this existing logic and rewrite it to work with Cloudflare's Browser Rendering service while maintaining the same functionality.

## Current Scraping Analysis

### Existing Files to Analyze:
- `root/src/tools/extract_policy_with_crawlee.ts` - Policy extraction logic
- `root/src/tools/deep_research.ts` - Deep research scraping
- Any other scraping-related utilities in the tools directory

### Current Scraping Patterns:
1. **Policy Extraction**: Extracting travel policies from airline/hotel websites
2. **Deep Research**: Comprehensive data gathering from multiple sources
3. **Dynamic Content**: Handling JavaScript-rendered content
4. **Data Extraction**: Structured data extraction from various formats

## Migration Strategy

### 1. Analyze Existing Scrapers
First, examine the current scraping implementations:

```typescript
// Analyze these patterns from existing code:
// - Navigation patterns
// - Wait strategies
// - Data extraction selectors
// - Error handling approaches
// - Content parsing logic
```

### 2. Create Browser Rendering Adapters
Adapt existing logic to Cloudflare Browser Rendering:

```typescript
interface BrowserAdapter {
  navigate(url: string, options?: NavigationOptions): Promise<void>;
  waitFor(selector: string, timeout?: number): Promise<void>;
  extract(selectors: ExtractionSelectors): Promise<ExtractedData>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
}
```

## Implementation Components

### 1. Core Browser Service (`src/core/browser-service.ts`)
```typescript
export class CloudflareBrowserService {
  constructor(private browser: Browser) {}

  async createSession(): Promise<BrowserSession> {
    return await this.browser.connect();
  }

  async scrapeWithRetry(
    url: string,
    extractor: DataExtractor,
    retries = 3
  ): Promise<ScrapedData> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await this.performScrape(url, extractor);
      } catch (error) {
        if (attempt === retries - 1) throw error;
        await this.delay(Math.pow(2, attempt) * 1000);
      }
    }
  }

  private async performScrape(url: string, extractor: DataExtractor): Promise<ScrapedData> {
    const session = await this.createSession();
    const page = await session.newPage();

    try {
      // Set realistic browser settings
      await page.setUserAgent(this.getRandomUserAgent());
      await page.setViewportSize({ width: 1920, height: 1080 });

      // Navigate with proper wait conditions
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      // Extract data using provided extractor
      return await extractor.extract(page);
    } finally {
      await page.close();
      await session.close();
    }
  }
}
```

### 2. Data Extractors
Migrate existing extraction logic to new format:

#### Policy Extractor (`src/scrapers/extractors/policy-extractor.ts`)
```typescript
export class PolicyExtractor implements DataExtractor {
  async extract(page: Page): Promise<PolicyData> {
    // Wait for policy content to load
    await page.waitForSelector('.policy-content, .terms-content', { timeout: 10000 });

    // Extract policy sections
    const policies = await page.evaluate(() => {
      const sections = document.querySelectorAll('h2, h3, .policy-section');
      return Array.from(sections).map(section => ({
        title: section.textContent?.trim(),
        content: section.nextElementSibling?.textContent?.trim()
      }));
    });

    // Extract specific policy types
    const cancellationPolicy = await this.extractCancellationPolicy(page);
    const baggagePolicy = await this.extractBaggagePolicy(page);
    const changePolicy = await this.extractChangePolicy(page);

    return {
      url: page.url(),
      extractedAt: Date.now(),
      policies,
      cancellation: cancellationPolicy,
      baggage: baggagePolicy,
      changes: changePolicy,
      rawHtml: await page.content()
    };
  }

  private async extractCancellationPolicy(page: Page): Promise<string> {
    const selectors = [
      '[data-policy="cancellation"]',
      '.cancellation-policy',
      'h3:contains("Cancellation") + p',
      'h2:contains("Cancel") + div'
    ];

    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          return await element.textContent() || '';
        }
      } catch (error) {
        // Continue to next selector
      }
    }

    return '';
  }
}
```

#### Research Extractor (`src/scrapers/extractors/research-extractor.ts`)
```typescript
export class ResearchExtractor implements DataExtractor {
  async extract(page: Page): Promise<ResearchData> {
    // Handle different content types
    const contentType = await this.detectContentType(page);

    switch (contentType) {
      case 'hotel':
        return await this.extractHotelData(page);
      case 'flight':
        return await this.extractFlightData(page);
      case 'attraction':
        return await this.extractAttractionData(page);
      default:
        return await this.extractGenericData(page);
    }
  }

  private async detectContentType(page: Page): Promise<string> {
    // Detect content type based on page structure
    const indicators = await page.evaluate(() => {
      return {
        hasFlightInfo: !!document.querySelector('.flight-info, .flight-search'),
        hasHotelInfo: !!document.querySelector('.hotel-info, .room-details'),
        hasAttractionInfo: !!document.querySelector('.attraction, .tourist-spot')
      };
    });

    if (indicators.hasFlightInfo) return 'flight';
    if (indicators.hasHotelInfo) return 'hotel';
    if (indicators.hasAttractionInfo) return 'attraction';
    return 'generic';
  }
}
```

### 3. Smart Wait Strategies
Implement intelligent waiting for dynamic content:

```typescript
export class SmartWaitStrategy {
  async waitForContent(page: Page, options: WaitOptions): Promise<void> {
    const {
      selectors = [],
      timeout = 30000,
      networkIdle = true,
      customCondition
    } = options;

    // Wait for network to be idle
    if (networkIdle) {
      await page.waitForLoadState('networkidle');
    }

    // Wait for specific selectors
    if (selectors.length > 0) {
      await Promise.race(
        selectors.map(selector =>
          page.waitForSelector(selector, { timeout })
        )
      );
    }

    // Wait for custom condition
    if (customCondition) {
      await page.waitForFunction(customCondition, { timeout });
    }

    // Additional wait for JavaScript-heavy sites
    await page.waitForTimeout(2000);
  }
}
```

### 4. Anti-Detection Measures
Implement stealth techniques for reliable scraping:

```typescript
export class StealthBrowser {
  async setupStealth(page: Page): Promise<void> {
    // Set realistic viewport
    await page.setViewportSize({
      width: 1366 + Math.floor(Math.random() * 200),
      height: 768 + Math.floor(Math.random() * 200)
    });

    // Randomize user agent
    await page.setUserAgent(this.getRandomUserAgent());

    // Set headers to look more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    // Block unnecessary resources for faster loading
    await page.route('**/*', route => {
      const resourceType = route.request().resourceType();
      if (['image', 'stylesheet', 'font'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });
  }

  private getRandomUserAgent(): string {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
}
```

## Migration Tasks

### 1. Extract Current Logic
- [ ] Analyze `extract_policy_with_crawlee.ts`
- [ ] Analyze `deep_research.ts`
- [ ] Identify all scraping patterns and selectors
- [ ] Document current navigation flows
- [ ] List all data extraction rules

### 2. Create New Implementations
- [ ] Implement `CloudflareBrowserService`
- [ ] Create policy extractor for Browser Rendering
- [ ] Create research extractor for Browser Rendering
- [ ] Implement smart wait strategies
- [ ] Add anti-detection measures

### 3. Maintain Functionality Parity
- [ ] Ensure all scraped data fields are preserved
- [ ] Maintain error handling robustness
- [ ] Keep performance characteristics similar
- [ ] Preserve retry and fallback logic

### 4. Optimize for Edge
- [ ] Minimize browser session duration
- [ ] Implement efficient resource usage
- [ ] Add proper cleanup and disposal
- [ ] Optimize for cold start performance

## Files to Create

### Core Services:
- `src/core/browser-service.ts` - Main browser service
- `src/core/stealth-browser.ts` - Anti-detection measures
- `src/core/smart-wait.ts` - Intelligent waiting strategies

### Extractors:
- `src/scrapers/extractors/base-extractor.ts` - Base extractor interface
- `src/scrapers/extractors/policy-extractor.ts` - Policy extraction
- `src/scrapers/extractors/research-extractor.ts` - Research extraction
- `src/scrapers/extractors/hotel-extractor.ts` - Hotel-specific extraction
- `src/scrapers/extractors/flight-extractor.ts` - Flight-specific extraction

### Utilities:
- `src/utils/selector-builder.ts` - Dynamic selector building
- `src/utils/content-detector.ts` - Content type detection
- `src/utils/data-normalizer.ts` - Data normalization

## Success Criteria
- [ ] All existing scraping functionality migrated
- [ ] Browser Rendering integration working
- [ ] Performance parity with original implementation
- [ ] Error handling and retry logic preserved
- [ ] Anti-detection measures effective
- [ ] Memory and resource usage optimized
- [ ] Integration with queue system working

## Testing Requirements
- Compare extracted data with original scrapers
- Test against various website types
- Validate error handling scenarios
- Performance benchmarks vs original
- Anti-detection effectiveness tests
- Edge case handling validation

## Dependencies
- Browser Rendering service access
- Scraper Worker implementation (Task 8)
- Queue integration (Task 9)
- Analysis of existing scraping code
- R2 storage for scraped content (Task 5)
