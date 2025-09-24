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
  input.log?.debug?.({ 
    replyLength: input.reply?.length || 0,
    reply: input.reply?.substring(0, 200),
    factsCount: input.facts?.length || 0,
    facts: input.facts?.slice(0, 3),
    latestUser: input.latestUser?.substring(0, 100),
    previousUsersCount: input.previousUsers?.length || 0,
    lastIntent: input.lastIntent,
    slotsKeys: Object.keys(input.slotsSummary || {})
  }, '🔧 VERIFY: Starting verifyAnswer');
  
  const system = await getPrompt('verify');
  const ctx = {
    latest_user_message: input.latestUser || '',
    previous_user_messages: (input.previousUsers || []).slice(-2),
    assistant_reply: input.reply,
    slots_summary: input.slotsSummary || {},
    last_intent: input.lastIntent || '',
    evidence_facts: input.facts || [],
  };
  
  input.log?.debug?.({ 
    systemPromptLength: system.length,
    contextSize: JSON.stringify(ctx).length,
    evidenceFactsCount: ctx.evidence_facts.length
  }, '🔧 VERIFY: Prepared verification context');
  
  const payload = `${system}\n\nReturn STRICT JSON only.\n\nINPUT:\n${JSON.stringify(ctx)}`;
  const FAILSAFE = (process.env.LLM_FAILSAFE ?? '').toLowerCase() === 'on' || (process.env.LLM_FAILSAFE ?? '').toLowerCase() === 'true';
  
  try {
    input.log?.debug?.({ 
      payloadLength: payload.length,
      failsafeEnabled: FAILSAFE
    }, '🔧 VERIFY: Calling LLM for verification');
    
    const raw = await callLLM(payload, { responseFormat: 'json', log: input.log });
    
    input.log?.debug?.({ 
      rawLength: raw.length,
      rawSample: raw.substring(0, 300)
    }, '🔧 VERIFY: LLM verification response received');
    
    // Try parsing an embedded JSON object if model returned extra text
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      input.log?.debug?.({ parsed }, '🔧 VERIFY: JSON parsed successfully');
    } catch (parseError) {
      input.log?.debug?.({ parseError: String(parseError) }, '🔧 VERIFY: Initial JSON parse failed, trying regex extraction');
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        parsed = JSON.parse(m[0]);
        input.log?.debug?.({ parsed }, '🔧 VERIFY: JSON extracted from regex match');
      } else {
        parsed = {};
        input.log?.error?.({ raw }, '🔧 VERIFY: No JSON found in response');
      }
    }
    
    const result = VerifySchema.parse(parsed);
    
    input.log?.debug?.({ 
      verdict: result.verdict,
      confidence: result.confidence,
      notesCount: result.notes?.length || 0,
      notes: result.notes,
      hasScores: !!result.scores,
      scores: result.scores,
      hasRevisedAnswer: !!result.revisedAnswer,
      revisedAnswerLength: result.revisedAnswer?.length || 0
    }, '🔧 VERIFY: Verification completed successfully');
    
    return result;
  } catch (err) {
    input.log?.error?.({ 
      error: String(err),
      failsafeEnabled: FAILSAFE,
      factsCount: input.facts?.length || 0
    }, '🔧 VERIFY: Verification failed');
    
    if (FAILSAFE) {
      const fallback: VerifyResult = {
        verdict: 'warn',
        notes: ['offline_or_timeout'],
        scores: { relevance: 0.5, grounding: 0.5, coherence: 0.5, context_consistency: 0.5 },
      };
      
      input.log?.debug?.({ fallback }, '🔧 VERIFY: Using failsafe fallback result');
      return fallback;
    }
    throw err;
  }
}
