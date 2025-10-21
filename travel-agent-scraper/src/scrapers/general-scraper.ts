import type { Page } from "@cloudflare/playwright";
import { BaseScraper, type ScraperResult } from "@/scrapers/base-scraper";
import type { ScrapingMessage } from "@/types/messages";

export class GeneralScraper extends BaseScraper {
  protected async extract(page: Page, message: ScrapingMessage): Promise<ScraperResult> {
    const title = await page.title();
    const description = await this.extractDescription(page);
    const html = await page.content();

    return {
      type: message.type,
      url: message.url,
      title,
      description,
      data: {
        headings: await this.extractHeadings(page),
        links: await this.extractLinks(page),
      },
      html,
    };
  }

  private async extractDescription(page: Page): Promise<string | undefined> {
    return page
      .locator('meta[name="description"]')
      .first()
      .getAttribute("content")
      .catch(() => undefined);
  }

  private async extractHeadings(page: Page): Promise<string[]> {
    const headings = await page.$$eval("h1, h2, h3", (elements) =>
      elements.map((element) => element.textContent?.trim()).filter(Boolean),
    );
    return headings as string[];
  }

  private async extractLinks(page: Page): Promise<Array<{ text: string; href: string }>> {
    return page.$$eval("a[href]", (elements) =>
      elements
        .map((element) => ({
          text: element.textContent?.trim() ?? "",
          href: (element as HTMLAnchorElement).href,
        }))
        .filter((link) => Boolean(link.text) || Boolean(link.href)),
    );
  }
}
