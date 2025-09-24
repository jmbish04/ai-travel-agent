import pino from 'pino';
import { getPrompt } from '../core/prompts.js';
import { setLastReceipts, getThreadSlots } from '../core/slot_memory.js';
import { callChatWithTools } from './tools/index.js';

export type MetaAgentOutput = {
  reply: string;
  citations?: string[];
};

/**
 * Run a single Meta‑Agent turn using the giant meta prompt and tool calling.
 * Loads `meta_agent.md` (self‑contained).
 */
export async function runMetaAgentTurn(
  message: string,
  threadId: string,
  opts: { log?: pino.Logger } = {},
): Promise<MetaAgentOutput> {
  const log = opts.log || pino({ level: process.env.LOG_LEVEL || 'info' });
  const meta = await getPrompt('meta_agent');
  const ctxSlots = await getThreadSlots(threadId);

  const { result, facts, decisions, citations } = await callChatWithTools({
    system: meta,
    user: message,
    context: ctxSlots,
    maxSteps: 8,
    timeoutMs: 20000,
    log,
  });

  try {
    if (facts?.length || decisions?.length) {
      await setLastReceipts(threadId, facts || [], decisions || [], result);
    }
  } catch {
    // best-effort
  }

  return { reply: result, citations };
}
