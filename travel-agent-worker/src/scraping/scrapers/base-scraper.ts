import type { Page } from "@cloudflare/playwright";
import type { ScrapeOptions, ScrapingMessage } from "../types/messages";
import { SmartWaitStrategy } from "../utils/smart-wait";

export interface ScraperResult {
  type: ScrapingMessage["type"];
  url: string;
  title?: string;
  description?: string;
  data: Record<string, unknown>;
  html: string;
  images?: string[];
  reviews?: Array<Record<string, unknown>>;
}

export abstract class BaseScraper {
  protected constructor(private readonly waitStrategy = new SmartWaitStrategy()) {}

  async scrape(page: Page, message: ScrapingMessage): Promise<ScraperResult> {
    await this.waitForContent(page, message.options);
    return this.extract(page, message);
  }

  protected async waitForContent(page: Page, options: ScrapeOptions): Promise<void> {
    await this.waitStrategy.waitForContent(page, {
      selectors: [options.waitFor ?? "main", ...(options.waitForSelectors ?? [])],
      timeout: options.timeoutMs,
    });
  }

  protected abstract extract(page: Page, message: ScrapingMessage): Promise<ScraperResult>;
}
