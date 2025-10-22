import { chromium, type Browser, type BrowserContext, type Page } from "@cloudflare/playwright";
import type { ScrapeOptions, ScrapingMessage } from "./types/messages";
import { StealthBrowser } from "./utils/stealth-browser";
import { SmartWaitStrategy } from "./utils/smart-wait";
import type { ScraperEnv } from "./types/env";
import type { BaseScraper, ScraperResult } from "./scrapers/base-scraper";
import { createScraper } from "./scrapers/create-scraper";

export interface ScrapeContext {
  env: ScraperEnv;
  message: ScrapingMessage;
}

export class BrowserController {
  private readonly stealth = new StealthBrowser();
  private readonly waitStrategy = new SmartWaitStrategy();
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly env: ScraperEnv) {}

  static async launch(env: ScraperEnv): Promise<BrowserController> {
    const controller = new BrowserController(env);
    await controller.ensureBrowser();
    return controller;
  }

  async scrape(message: ScrapingMessage): Promise<ScraperResult> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await this.preparePage(page, message.options);
      await this.navigate(page, message.url, message.options);

      const scraper = createScraper(message.type);
      return await scraper.scrape(page, message);
    } finally {
      await this.disposeContext(context);
    }
  }

  async close(): Promise<void> {
    if (!this.browserPromise) {
      return;
    }

    const browser = await this.browserPromise;
    await browser.close();
    this.browserPromise = null;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch(this.env.BROWSER);
    }
    return this.browserPromise;
  }

  private async preparePage(page: Page, options: ScrapeOptions): Promise<void> {
    await this.stealth.setupStealth(page);

    if (options.waitForSelectors?.length) {
      this.waitStrategy.waitForContent(page, {
        selectors: options.waitForSelectors,
        timeout: options.timeoutMs,
        networkIdle: true,
      }).catch((error) => console.warn("Initial wait strategy failed", error));
    }
  }

  private async navigate(page: Page, url: string, options: ScrapeOptions): Promise<void> {
    const timeout = options.timeoutMs ?? 30_000;
    await page.goto(url, { waitUntil: "networkidle", timeout }).catch(async (error) => {
      console.warn("Primary navigation failed, retrying with load state", error);
      await page.goto(url, { waitUntil: "load", timeout });
    });
  }

  private async disposeContext(context: BrowserContext): Promise<void> {
    try {
      await Promise.allSettled(
        context.pages().map(async (page) => {
          try {
            await page.close();
          } catch (error) {
            console.error("Failed to close page", error);
          }
        }),
      );
    } finally {
      await context.close();
    }
  }
}
