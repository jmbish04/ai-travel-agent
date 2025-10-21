import type { ScrapingMessage } from "@/types/messages";
import { BaseScraper } from "@/scrapers/base-scraper";
import { HotelScraper } from "@/scrapers/hotel-scraper";
import { FlightScraper } from "@/scrapers/flight-scraper";
import { AttractionScraper } from "@/scrapers/attraction-scraper";
import { GeneralScraper } from "@/scrapers/general-scraper";

export function createScraper(type: ScrapingMessage["type"]): BaseScraper {
  switch (type) {
    case "hotel":
      return new HotelScraper();
    case "flight":
      return new FlightScraper();
    case "attraction":
      return new AttractionScraper();
    default:
      return new GeneralScraper();
  }
}
