import type { Page } from "@cloudflare/playwright";
import { BaseScraper, type ScraperResult } from "@/scrapers/base-scraper";
import type { ScrapingMessage } from "@/types/messages";
import { extractNumber, extractTextContent, sanitizeText } from "@/utils/data-extraction";

export class AttractionScraper extends BaseScraper {
  protected async extract(page: Page, message: ScrapingMessage): Promise<ScraperResult> {
    const title = await this.extractTitle(page);
    const description = await this.extractDescription(page);
    const html = await page.content();
    const rating = await this.extractRating(page);
    const price = await this.extractPrice(page);

    return {
      type: message.type,
      url: message.url,
      title,
      description,
      data: {
        rating,
        price,
        highlights: await this.extractHighlights(page),
        openingHours: await this.extractOpeningHours(page),
        location: await this.extractLocation(page),
      },
      images: await this.extractImages(page, message.options.extractImages ?? false),
      reviews: message.options.extractReviews ? await this.extractReviews(page) : undefined,
      html,
    };
  }

  private async extractTitle(page: Page): Promise<string | undefined> {
    const selectors = ["h1", "[data-testid='title']", ".attraction-title", "[itemprop='name']"];
    for (const selector of selectors) {
      const title = await extractTextContent(page, selector);
      if (title) return sanitizeText(title);
    }
    return undefined;
  }

  private async extractDescription(page: Page): Promise<string | undefined> {
    const selectors = ["[data-testid='description']", ".summary", "meta[name='description']"];
    for (const selector of selectors) {
      const text = await extractTextContent(page, selector);
      if (text) return sanitizeText(text);
    }
    return undefined;
  }

  private async extractRating(page: Page): Promise<number | undefined> {
    const selectors = ["[data-testid='rating']", "[itemprop='ratingValue']", "[class*='rating']"];
    for (const selector of selectors) {
      const rating = await extractNumber(page, selector);
      if (rating) return rating;
    }
    return undefined;
  }

  private async extractPrice(page: Page): Promise<number | undefined> {
    const selectors = ["[data-testid='price']", "[class*='price']", "[itemprop='price']"];
    for (const selector of selectors) {
      const price = await extractNumber(page, selector);
      if (price) return price;
    }
    return undefined;
  }

  private async extractHighlights(page: Page): Promise<string[]> {
    const selectors = ["[data-testid='highlights'] li", "[class*='highlight']", "ul.features li"];
    for (const selector of selectors) {
      const highlights = await page.$$eval(selector, (nodes) =>
        nodes.map((node) => node.textContent?.trim()).filter(Boolean),
      );
      if (highlights.length > 0) return highlights as string[];
    }
    return [];
  }

  private async extractOpeningHours(page: Page): Promise<Record<string, string> | undefined> {
    const rows = await page.$$('[data-testid="hours-row"], .opening-hours tr');
    if (!rows.length) {
      return undefined;
    }

    const hours: Record<string, string> = {};
    for (const row of rows) {
      const day = await row
        .$('[data-testid="day"], th, .day')
        .then((element) => element?.textContent())
        .catch(() => undefined);
      const time = await row
        .$('[data-testid="time"], td, .time')
        .then((element) => element?.textContent())
        .catch(() => undefined);
      if (day && time) {
        hours[day] = sanitizeText(time) ?? time;
      }
    }
    return Object.keys(hours).length > 0 ? hours : undefined;
  }

  private async extractLocation(page: Page): Promise<string | undefined> {
    const selectors = ["[data-testid='location']", "[itemprop='address']", ".location"];
    for (const selector of selectors) {
      const text = await extractTextContent(page, selector);
      if (text) return sanitizeText(text);
    }
    return undefined;
  }

  private async extractImages(page: Page, enabled: boolean): Promise<string[] | undefined> {
    if (!enabled) {
      return undefined;
    }
    const images = await page.$$eval("img", (nodes) =>
      nodes
        .map((node) => (node as HTMLImageElement).src)
        .filter((src) => Boolean(src) && !src.startsWith("data:")),
    );
    return Array.from(new Set(images)) as string[];
  }

  private async extractReviews(page: Page): Promise<Array<Record<string, unknown>>> {
    const reviewElements = await page.$$('[data-testid="review"], .review, [itemprop="review"]');
    const reviews: Array<Record<string, unknown>> = [];

    for (const element of reviewElements) {
      const author = await element
        .$('[itemprop="author"], .review-author')
        .then((node) => node?.textContent?.trim())
        .catch(() => undefined);
      const rating = await element
        .$('[itemprop="ratingValue"], .review-rating')
        .then((node) => node?.textContent?.trim())
        .catch(() => undefined);
      const text = await element
        .$('[itemprop="reviewBody"], .review-text')
        .then((node) => node?.textContent?.trim())
        .catch(() => undefined);

      reviews.push(
        Object.fromEntries(
          Object.entries({
            author,
            rating,
            text,
          }).filter(([, value]) => Boolean(value)),
        ),
      );
    }

    return reviews.filter((review) => Object.keys(review).length > 0);
  }
}
