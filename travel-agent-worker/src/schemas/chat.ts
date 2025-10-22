import { z } from 'zod';

/**
 * Chat input schema - migrated from the original project
 */
export const ChatInput = z.object({
	message: z.string(),
	threadId: z.string().optional(),
	receipts: z.boolean().optional(),
	sessionId: z.string().optional(),
	userId: z.string().optional(),
});

export type ChatInput = z.infer<typeof ChatInput>;

/**
 * Chat output schema - migrated from the original project
 */
export const ChatOutput = z.object({
	reply: z.string(),
	threadId: z.string(),
	sources: z.array(z.any()).optional(),
	receipts: z.any().optional(),
	sessionId: z.string().optional(),
});

export type ChatOutput = z.infer<typeof ChatOutput>;
