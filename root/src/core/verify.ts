import { z } from 'zod';
import type pino from 'pino';
import { callLLM } from './llm.js';
import { getPrompt } from './prompts.js';

const ScoreSchema = z.object({
  relevance: z.number().min(0).max(1),
  grounding: z.number().min(0).max(1),
  coherence: z.number().min(0).max(1),
  context_consistency: z.number().min(0).max(1),
});

const VerifySchema = z.object({
  verdict: z.enum(['pass', 'warn', 'fail']),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.array(z.string()),
  scores: ScoreSchema.optional(),
  violations: z.array(z.string()).optional(),
  missing_context: z.array(z.string()).optional(),
  revisedAnswer: z.string().optional(),
});
export type VerifyResult = z.infer<typeof VerifySchema>;

export async function verifyAnswer(input: {
  reply: string;
  facts: Array<{ key: string; value: unknown; source: string }>;
  log?: pino.Logger;
  latestUser?: string;
  previousUsers?: string[];
  slotsSummary?: Record<string, string>;
  lastIntent?: string;
}): Promise<VerifyResult> {
  const system = await getPrompt('verify');
  const ctx = {
    latest_user_message: input.latestUser || '',
    previous_user_messages: (input.previousUsers || []).slice(-2),
    assistant_reply: input.reply,
    slots_summary: input.slotsSummary || {},
    last_intent: input.lastIntent || '',
    evidence_facts: input.facts || [],
  };
  const payload = `${system}\n\nReturn STRICT JSON only.\n\nINPUT:\n${JSON.stringify(ctx)}`;
  const raw = await callLLM(payload, { responseFormat: 'json', log: input.log });
  // Try parsing an embedded JSON object if model returned extra text
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }
  return VerifySchema.parse(parsed);
}

