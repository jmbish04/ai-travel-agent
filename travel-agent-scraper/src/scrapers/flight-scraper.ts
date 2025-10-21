import type { Page } from "@cloudflare/playwright";
import { BaseScraper, type ScraperResult } from "@/scrapers/base-scraper";
import type { ScrapingMessage } from "@/types/messages";
import { extractNumber, extractTextContent, sanitizeText } from "@/utils/data-extraction";

export class FlightScraper extends BaseScraper {
  protected async extract(page: Page, message: ScrapingMessage): Promise<ScraperResult> {
    const html = await page.content();
    const flights = await this.extractFlights(page);
    const price = await this.extractPrice(page);

    return {
      type: message.type,
      url: message.url,
      title: await this.extractTitle(page),
      description: await this.extractDescription(page),
      data: {
        flights,
        price,
        airlines: this.collectAirlines(flights),
        duration: await this.extractDuration(page),
        baggagePolicy: await this.extractBaggagePolicy(page),
      },
      html,
    };
  }

  private async extractFlights(page: Page): Promise<Array<Record<string, unknown>>> {
    const flightRows = await page.$$(
      '[data-testid="flight-result"], .flight-result, [role="article"].flight',
    );

    if (flightRows.length === 0) {
      return [];
    }

    const flights: Array<Record<string, unknown>> = [];

    for (const row of flightRows) {
      const departure = await row
        .$('[data-testid="departure"], .departure, time[datetime]')
        .then((el) => el?.textContent())
        .catch(() => undefined);
      const arrival = await row
        .$('[data-testid="arrival"], .arrival, time[datetime]')
        .then((el) => el?.textContent())
        .catch(() => undefined);
      const airline = await row
        .$('[data-testid="airline-name"], .airline-name, [itemprop="name"]')
        .then((el) => el?.textContent())
        .catch(() => undefined);
      const duration = await row
        .$('[data-testid="duration"], .flight-duration')
        .then((el) => el?.textContent())
        .catch(() => undefined);

      flights.push(
        Object.fromEntries(
          Object.entries({
            departure: sanitizeText(departure ?? undefined),
            arrival: sanitizeText(arrival ?? undefined),
            airline: sanitizeText(airline ?? undefined),
            duration: sanitizeText(duration ?? undefined),
          }).filter(([, value]) => Boolean(value)),
        ),
      );
    }

    return flights.filter((flight) => Object.keys(flight).length > 0);
  }

  private async extractPrice(page: Page): Promise<number | undefined> {
    const selectors = [
      "[data-testid='flight-price']",
      "[class*='totalPrice']",
      "[class*='price']",
    ];

    for (const selector of selectors) {
      const value = await extractNumber(page, selector);
      if (value) return value;
    }
    return undefined;
  }

  private async extractTitle(page: Page): Promise<string | undefined> {
    const title = await page.title();
    return title ? sanitizeText(title) : undefined;
  }

  private async extractDescription(page: Page): Promise<string | undefined> {
    const summary = await extractTextContent(page, "meta[name='description']");
    return sanitizeText(summary);
  }

  private collectAirlines(flights: Array<Record<string, unknown>>): string[] {
    return Array.from(
      new Set(
        flights
          .map((flight) => flight.airline)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    );
  }

  private async extractDuration(page: Page): Promise<string | undefined> {
    const selectors = ["[data-testid='duration-filter']", "[class*='duration']", "[aria-label*='duration']"];
    for (const selector of selectors) {
      const text = await extractTextContent(page, selector);
      if (text) return sanitizeText(text);
    }
    return undefined;
  }

  private async extractBaggagePolicy(page: Page): Promise<string | undefined> {
    const selectors = [
      "text=Baggage",
      "[data-testid='baggage-policy']",
      "[class*='baggage']",
    ];
    for (const selector of selectors) {
      const text = await extractTextContent(page, selector);
      if (text) return sanitizeText(text);
    }
    return undefined;
  }
}
