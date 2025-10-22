import type { Message, MessageBatch } from "@cloudflare/workers-types";
import { BrowserController } from "./browser-controller";
import type { ScraperEnv } from "./types/env";
import { QueueMessageSchema, type QueueMessage } from "./types/messages";
import { validateUrl, normalizeUrl } from "./utils/url-validation";
import { persistScrapeResult, updateQueueStatus } from "./utils/storage-helpers";

const RETRYABLE_ERRORS = ["Timeout", "ECONNRESET", "Navigation timeout", "ERR"];

export async function handleQueue(
  batch: MessageBatch<QueueMessage>,
  env: ScraperEnv,
): Promise<void> {
  const controller = await BrowserController.launch(env);

  try {
    await Promise.all(
      batch.messages.map((message) => processMessage(message, controller, env)),
    );
  } finally {
    await controller.close();
  }
}

async function processMessage(
  message: Message<QueueMessage>,
  controller: BrowserController,
  env: ScraperEnv,
): Promise<void> {
  const parsed = QueueMessageSchema.safeParse(message.body);

  if (!parsed.success) {
    console.error("Invalid queue message", parsed.error);
    message.ack();
    return;
  }

  const queueMessage = parsed.data;
  await updateQueueStatus(env, queueMessage.id, "processing");

  try {
    const scrapeMessage = queueMessage.payload;
    const { valid, reason } = validateUrl(scrapeMessage.url);
    if (!valid) {
      throw new Error(`Invalid URL: ${reason ?? "unknown reason"}`);
    }

    const normalizedUrl = normalizeUrl(scrapeMessage.url);
    let fallbackUsed = false;
    let result = await controller
      .scrape({ ...scrapeMessage, url: normalizedUrl })
      .catch(async (browserError) => {
        console.warn("Browser scraping failed, attempting fallback", {
          id: queueMessage.id,
          error: (browserError as Error).message,
        });
        fallbackUsed = true;
        try {
          return await fallbackScrape(scrapeMessage.type, normalizedUrl);
        } catch (fallbackError) {
          console.error("Fallback scraping failed", {
            id: queueMessage.id,
            error: (fallbackError as Error).message,
          });
          throw fallbackError; // Re-throw the error to be caught by the outer catch block
        }
      });

    const metadata = {
      ...queueMessage.metadata,
      requestedAt: queueMessage.metadata.scheduledAt,
      scrapedAt: Date.now(),
      fallbackUsed,
    } satisfies Record<string, unknown>;

    await persistScrapeResult(env, {
      id: scrapeMessage.id ?? queueMessage.id,
      url: normalizedUrl,
      type: scrapeMessage.type,
      html: result.html,
      extractedAt: metadata.scrapedAt,
      data: {
        ...result.data,
        title: result.title,
        description: result.description,
        images: result.images,
        reviews: result.reviews,
      },
      metadata,
      userId: queueMessage.metadata.userId,
      sessionId: queueMessage.metadata.sessionId,
    });

    await updateQueueStatus(env, queueMessage.id, "completed");
    message.ack();
  } catch (error) {
    const messageError = error as Error;
    const retryable = isRetryable(messageError);

    console.error("Scraping failed", {
      id: message.id,
      error: messageError.message,
      stack: messageError.stack,
      retryable,
    });

    await updateQueueStatus(env, queueMessage.id, "failed", messageError.message);

    if (retryable) {
      message.retry();
    } else {
      message.ack();
    }
  }
}

function isRetryable(error: Error): boolean {
  if ("status" in error && typeof (error as { status?: number }).status === "number") {
    const status = (error as { status: number }).status;
    if (status >= 400 && status < 500 && status !== 429) {
      return false;
    }
  }

  return RETRYABLE_ERRORS.some((token) => error.message.includes(token));
}

async function fallbackScrape(type: QueueMessage["payload"]["type"], url: string) {
  const response = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: false } });
  if (!response.ok) {
    throw new Error(`Fallback fetch failed with status ${response.status}`);
  }

  const html = await response.text();
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const descriptionMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  );

  return {
    type,
    url,
    title: titleMatch?.[1]?.trim(),
    description: descriptionMatch?.[1]?.trim(),
    html,
    data: {
      fallback: true,
      contentLength: html.length,
    },
  };
}
