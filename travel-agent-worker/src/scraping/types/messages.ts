import { z } from "zod";

export const ScrapePrioritySchema = z.union([
  z.literal("low"),
  z.literal("normal"),
  z.literal("high"),
  z.literal("urgent"),
]);

export const ScrapeOptionsSchema = z
  .object({
    waitFor: z.string().min(1).optional(),
    extractImages: z.boolean().optional(),
    extractReviews: z.boolean().optional(),
    maxPages: z.number().int().positive().optional(),
    waitForSelectors: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .default({});

export const ScrapingMetadataSchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  requestedAt: z.number().int(),
  priority: ScrapePrioritySchema.default("normal"),
});

export const ScrapingMessageSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  type: z.union([
    z.literal("hotel"),
    z.literal("flight"),
    z.literal("attraction"),
    z.literal("general"),
  ]),
  options: ScrapeOptionsSchema,
  metadata: ScrapingMetadataSchema,
});

export const QueueMessageSchema = z.object({
  id: z.string(),
  type: z.literal("scrape_request"),
  payload: ScrapingMessageSchema,
  metadata: z.object({
    priority: ScrapePrioritySchema,
    scheduledAt: z.number().int(),
    maxRetries: z.number().int().nonnegative().default(3),
    timeoutMs: z.number().int().positive().default(30000),
    correlationId: z.string(),
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
});

export type ScrapingMessage = z.infer<typeof ScrapingMessageSchema>;
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
export type ScrapeOptions = z.infer<typeof ScrapeOptionsSchema>;
export type ScrapePriority = z.infer<typeof ScrapePrioritySchema>;

export interface ScrapedContent {
  id: string;
  url: string;
  type: ScrapingMessage["type"];
  html: string;
  extractedAt: number;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
}
