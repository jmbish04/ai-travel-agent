import pino from 'pino';
import { getPrompt } from '../core/prompts.js';
import { setLastReceipts, getThreadSlots, setLastUserMessage } from '../core/slot_memory.js';
import { observeMetaTurnLatency, incReceiptsWrittenTotal, addMetaCitationsCount } from '../util/metrics.js';
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
  
  log.debug({ 
    message: message.substring(0, 200),
    threadId,
    messageLength: message.length
  }, '🔧 META_AGENT: Starting runMetaAgentTurn');
  
  const meta = await getPrompt('meta_agent');
  log.debug({ 
    metaPromptLength: meta.length,
    metaPromptSample: meta.substring(0, 300)
  }, '🔧 META_AGENT: Meta prompt loaded');
  
  let ctxSlots = await getThreadSlots(threadId);
  log.debug({ 
    threadId,
    ctxSlots,
    slotsCount: Object.keys(ctxSlots).length
  }, '🔧 META_AGENT: Context slots retrieved');

  // Persist last user message for deictic resolution and heuristics
  try {
    await setLastUserMessage(threadId, message);
  } catch {}

  // Do not run any micro-prompts here; the meta prompt must infer and resolve
  // slots (from/to/dates) from the user message. We only persist the message.

  const turnStart = Date.now();
  
  log.debug({ 
    threadId,
    maxSteps: 8,
    timeoutMs: 20000
  }, '🔧 META_AGENT: Calling callChatWithTools');
  
  const { result, facts, decisions, citations } = await callChatWithTools({
    system: meta,
    user: message,
    context: ctxSlots,
    maxSteps: 8,
    timeoutMs: 20000,
    log,
  });

  log.debug({ 
    threadId,
    resultLength: result?.length || 0,
    result: result?.substring(0, 200),
    factsCount: facts?.length || 0,
    decisionsCount: decisions?.length || 0,
    citationsCount: citations?.length || 0,
    facts: facts?.slice(0, 3),
    decisions: decisions?.slice(0, 3),
    citations: citations?.slice(0, 3)
  }, '🔧 META_AGENT: callChatWithTools completed');

  try {
    log.debug({ 
      threadId,
      factsToStore: facts?.length || 0,
      decisionsToStore: decisions?.length || 0,
      result: result?.substring(0, 100)
    }, '🔧 META_AGENT: Storing receipts');

    await setLastReceipts(threadId, facts || [], decisions || [], result);
    incReceiptsWrittenTotal();

    log.debug({ threadId }, '🔧 META_AGENT: Receipts stored successfully');
  } catch (error) {
    log.error({ 
      threadId,
      error: String(error),
      factsCount: facts?.length || 0,
      decisionsCount: decisions?.length || 0
    }, '🔧 META_AGENT: Failed to store receipts');
  }
  
  if (Array.isArray(citations) && citations.length > 0) {
    addMetaCitationsCount(citations.length);
    log.debug({ 
      threadId,
      citationsCount: citations.length,
      citations
    }, '🔧 META_AGENT: Citations processed');
  }
  
  const turnLatency = Date.now() - turnStart;
  observeMetaTurnLatency(turnLatency);
  
  log.debug({ 
    threadId,
    turnLatency,
    finalReplyLength: result?.length || 0,
    finalCitationsCount: citations?.length || 0
  }, '🔧 META_AGENT: runMetaAgentTurn completed');

  return { reply: result, citations };
}
