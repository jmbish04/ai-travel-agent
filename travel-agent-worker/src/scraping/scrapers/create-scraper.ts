import type { ScrapingMessage } from "../types/messages";
import { BaseScraper } from "./base-scraper";
import { HotelScraper } from "./hotel-scraper";
import { FlightScraper } from "./flight-scraper";
import { AttractionScraper } from "./attraction-scraper";
import { GeneralScraper } from "./general-scraper";

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
