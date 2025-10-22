import type { Page } from "@cloudflare/playwright";

export interface WaitOptions {
  selectors?: string[];
  timeout?: number;
  networkIdle?: boolean;
  customCondition?: Parameters<Page["waitForFunction"]>[0];
}

export class SmartWaitStrategy {
  async waitForContent(page: Page, options: WaitOptions = {}): Promise<void> {
    const selectors = options.selectors?.filter(Boolean) ?? [];
    const timeout = options.timeout ?? 30_000;

    if (options.networkIdle ?? true) {
      try {
        await page.waitForLoadState("networkidle", { timeout });
      } catch (error) {
        console.warn("Network idle wait failed", error);
      }
    }

    if (selectors.length > 0) {
      await Promise.race(
        selectors.map((selector) => page.waitForSelector(selector, { timeout })),
      ).catch((error) => {
        console.warn("Selector wait failed", { selectors, error });
      });
    }

    if (options.customCondition) {
      try {
        await page.waitForFunction(options.customCondition, undefined, { timeout });
      } catch (error) {
        console.warn("Custom wait condition failed", error);
      }
    }

    await page.waitForTimeout(750);
  }
}
