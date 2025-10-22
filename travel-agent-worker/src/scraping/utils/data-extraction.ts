import type { Page } from "@cloudflare/playwright";

export async function extractTextContent(page: Page, selector: string): Promise<string | undefined> {
  const element = await page.$(selector);
  if (!element) {
    return undefined;
  }
  const content = await element.textContent();
  return content?.trim() || undefined;
}

export async function extractNumber(page: Page, selector: string): Promise<number | undefined> {
  const text = await extractTextContent(page, selector);
  if (!text) {
    return undefined;
  }

  const normalized = text.replace(/[^0-9.,-]/g, "");
  const parsed = Number(normalized.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizePrice(text: string | undefined): number | undefined {
  if (!text) {
    return undefined;
  }

  const match = text.match(/([0-9]+(?:[.,][0-9]{2})?)/);
  if (!match) {
    return undefined;
  }
  return Number.parseFloat(match[1].replace(/,/g, ""));
}

export function sanitizeText(text: string | undefined): string | undefined {
  return text?.replace(/\s+/g, " ").trim();
}
