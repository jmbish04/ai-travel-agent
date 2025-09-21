import { z } from 'zod';

export const ClauseType = z.enum(['baggage', 'refund', 'change', 'visa']);

export const DomainScoreSchema = z.object({
  domain: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.literal('llm_classified'),
  isOfficial: z.boolean()
});

export const PolicyReceiptSchema = z.object({
  url: z.string().url(),
  title: z.string().min(3),
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
  capturedAt: z.string().datetime(),
  quote: z.string().max(2000), // Remove min length requirement
  imgPath: z.string().optional(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['airline', 'hotel', 'visa', 'generic']),
  domainAuthenticity: DomainScoreSchema.optional()
});

export type PolicyReceipt = z.infer<typeof PolicyReceiptSchema>;
export type ClauseTypeT = z.infer<typeof ClauseType>;
export type DomainScore = z.infer<typeof DomainScoreSchema>;
