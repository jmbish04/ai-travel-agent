import type { Page } from "@cloudflare/playwright";
import { BaseScraper, type ScraperResult } from "./base-scraper";
import type { ScrapingMessage } from "../types/messages";
import { extractNumber, extractTextContent, sanitizeText } from "../utils/data-extraction";

export class HotelScraper extends BaseScraper {
  protected async extract(page: Page, message: ScrapingMessage): Promise<ScraperResult> {
    const title = await this.findHotelName(page);
    const description = await this.extractSummary(page);
    const price = await this.extractPrice(page);
    const rating = await this.extractRating(page);
    const amenities = await this.extractAmenities(page);
    const images = await this.extractImages(page, message.options.extractImages ?? false);
    const reviews = message.options.extractReviews ? await this.extractReviews(page) : undefined;

    return {
      type: message.type,
      url: message.url,
      title,
      description,
      data: {
        price,
        rating,
        amenities,
        address: await this.extractAddress(page),
        checkInPolicy: await this.extractPolicy(page, "check-in"),
        cancellationPolicy: await this.extractPolicy(page, "cancellation"),
      },
      images,
      reviews,
      html: await page.content(),
    };
  }

  private async findHotelName(page: Page): Promise<string | undefined> {
    const selectors = ["h1", "[data-testid='hotel-name']", ".hotel-name", "[itemprop='name']"];
    for (const selector of selectors) {
      const text = await extractTextContent(page, selector);
      if (text) return text;
    }
    return undefined;
  }

  private async extractSummary(page: Page): Promise<string | undefined> {
    const selectors = ["[data-testid='hotel-description']", "article p", ".hotel-summary", "meta[name='description']"];
    for (const selector of selectors) {
      const text = await extractTextContent(page, selector);
      if (text) return sanitizeText(text);
    }
    return undefined;
  }

  private async extractPrice(page: Page): Promise<number | undefined> {
    const selectors = [
      "[data-testid='price-display']",
      "[data-testid='room-price']",
      "[class*='Price']",
      "[class*='rate']",
    ];

    for (const selector of selectors) {
      const value = await extractNumber(page, selector);
      if (value) return value;
    }
    return undefined;
  }

  private async extractRating(page: Page): Promise<number | undefined> {
    const selectors = [
      "[data-testid='rating']",
      "[class*='rating']",
      "[itemprop='ratingValue']",
    ];
    for (const selector of selectors) {
      const value = await extractNumber(page, selector);
      if (value) return value;
    }
    return undefined;
  }

  private async extractAmenities(page: Page): Promise<string[]> {
    const selectors = [
      "[data-testid='amenities-list'] li",
      "[class*='amenity']",
      "[itemprop='amenityFeature']",
    ];
    for (const selector of selectors) {
      const amenities = await page.$$eval(selector, (nodes) =>
        nodes.map((node) => node.textContent?.trim()).filter(Boolean),
      );
      if (amenities.length > 0) return amenities as string[];
    }
    return [];
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
      const author = await element.$eval('[itemprop="author"], .review-author', (node) =>
        node.textContent?.trim(),
      ).catch(() => undefined);
      const rating = await element
        .$eval('[itemprop="ratingValue"], .review-rating', (node) => node.textContent?.trim())
        .catch(() => undefined);
      const text = await element
        .$eval('[itemprop="reviewBody"], .review-text', (node) => node.textContent?.trim())
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

  private async extractPolicy(page: Page, type: "check-in" | "cancellation"): Promise<string | undefined> {
    const selectors =
      type === "check-in"
        ? ["[data-testid='check-in-policy']", "[class*='checkin']", "text=Check-in"]
        : ["[data-testid='cancellation-policy']", "[class*='cancellation']", "text=Cancellation"];

    for (const selector of selectors) {
      const text = await extractTextContent(page, selector);
      if (text) return sanitizeText(text);
    }
    return undefined;
  }

  private async extractAddress(page: Page): Promise<string | undefined> {
    const selectors = ["[data-testid='property-address']", "[itemprop='streetAddress']", ".address"];
    for (const selector of selectors) {
      const text = await extractTextContent(page, selector);
      if (text) return sanitizeText(text);
    }
    return undefined;
  }
}
