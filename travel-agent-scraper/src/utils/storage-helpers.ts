import type { ScraperEnv } from "@/types/env";
import type { ScrapedContent } from "@/types/messages";

export interface PersistedScrape {
  id: string;
  r2Key: string;
}

export async function persistScrapeResult(env: ScraperEnv, content: ScrapedContent): Promise<PersistedScrape> {
  const r2Key = `scrapes/${content.id}.json`;
  await env.SCRAPED_DATA.put(r2Key, JSON.stringify(content), {
    httpMetadata: { contentType: "application/json" },
  });

  await env.DB.prepare(
    `INSERT INTO scraped_data (id, url, scrape_type, r2_key, metadata, user_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
        url = excluded.url,
        scrape_type = excluded.scrape_type,
        r2_key = excluded.r2_key,
        metadata = excluded.metadata,
        user_id = excluded.user_id,
        session_id = excluded.session_id,
        created_at = unixepoch()`
  )
    .bind(
      content.id,
      content.url,
      content.type,
      r2Key,
      content.metadata ? JSON.stringify(content.metadata) : null,
      content.userId ?? null,
      content.sessionId ?? null,
    )
    .run();

  return { id: content.id, r2Key };
}

export async function updateQueueStatus(
  env: ScraperEnv,
  messageId: string,
  status: "processing" | "completed" | "failed",
  errorMessage?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE queue_logs SET status = ?, error_message = ?, processed_at = unixepoch() WHERE message_id = ?`,
  )
    .bind(status, errorMessage ?? null, messageId)
    .run();
}
