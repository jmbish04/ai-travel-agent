import pino from 'pino';
import { getPrompt } from '../core/prompts.js';
import { createHash } from 'node:crypto';
import { setLastReceipts, getThreadSlots, setLastUserMessage } from '../core/slot_memory.js';
import { observeMetaTurnLatency, incReceiptsWrittenTotal, addMetaCitationsCount, addCitationDomain, observeStage } from '../util/metrics.js';
import { getLastIntent } from '../core/slot_memory.js';
import { callChatWithTools } from './tools/index.js';
import type { PipelineStatusUpdate } from '../core/pipeline_status.js';

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
  opts: { log?: pino.Logger; onStatus?: (update: PipelineStatusUpdate) => void } = {},
): Promise<MetaAgentOutput> {
  const log = opts.log || pino({ level: process.env.LOG_LEVEL || 'info' });
  const onStatus = opts.onStatus;
  
  log.debug({ 
    message: message.substring(0, 200),
    threadId,
    messageLength: message.length
  }, '🔧 META_AGENT: Starting runMetaAgentTurn');
  
  const meta = await getPrompt('meta_agent');
  try {
    const hash = createHash('sha256').update(meta).digest('hex').slice(0, 12);
    log.debug({ metaPromptHash: hash, metaPromptLength: meta.length }, '🔧 META_AGENT: Prompt version');
  } catch {}
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

  // Persist last user message for deictic resolution and context
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
  
  onStatus?.({ stage: 'plan', message: 'Generating tool execution plan...' });
  const { result, facts, decisions, citations } = await callChatWithTools({
    system: meta,
    user: message,
    context: ctxSlots,
    maxSteps: 10,
    // Policy/search flows may need extra time for tool calls + final synthesis
    timeoutMs: 60000,
    log,
    onStatus,
    threadId,
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

    await setLastReceipts(threadId, (facts || []).map(f => ({ ...f, source: f.source || 'internal' })), decisions || [], result);
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
    try {
      for (const c of citations) {
        if (!c) continue;
        let domain = c;
        try { domain = new URL(c).hostname || c; } catch {}
        addCitationDomain(domain);
      }
    } catch {}
  }
  
  const turnLatency = Date.now() - turnStart;
  observeMetaTurnLatency(turnLatency);
  try {
    const intent = await getLastIntent(threadId);
    observeStage('blend', turnLatency, Boolean(result && result.length > 0), intent || '');
  } catch {}
  
  log.debug({ 
    threadId,
    turnLatency,
    finalReplyLength: result?.length || 0,
    finalCitationsCount: citations?.length || 0
  }, '🔧 META_AGENT: runMetaAgentTurn completed');

  onStatus?.({ stage: 'compose', message: 'Polishing answer for delivery...' });

  return { reply: result, citations };
}
