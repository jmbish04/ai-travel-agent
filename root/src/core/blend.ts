import type pino from 'pino';
import { ChatInputT, ChatOutput } from '../schemas/chat.js';
import { getThreadId, pushMessage, getContext } from './memory.js';
import {
  setLastUserMessage,
  getLastReceipts,
  getLastVerification,
  setLastVerification,
  getLastIntent,
  getThreadSlots,
} from './slot_memory.js';
import { buildReceiptsSkeleton, ReceiptsSchema, type Fact, type Decision } from './receipts.js';
import { verifyAnswer } from './verify.js';
import { runMetaAgentTurn } from '../agent/meta_agent.js';
import {
  incMessages,
  incGeneratedAnswer,
  incAnswersWithCitations,
  incAnswerUsingExternal,
  observeE2E,
  incVerifyFail,
  incVerifyPass,
  incVerificationRun,
  observeVerifyScores,
  observeStage,
  observeStageVerification,
  observeConfidenceOutcome,
  getMetaRouteConfidence,
} from '../util/metrics.js';

type BlendContext = { log: pino.Logger; onStatus?: (status: string) => void };

const FORMAT_DECISION = (decision: string | Decision): string => {
  if (typeof decision === 'string') return decision;
  const parts = [`${decision.action} (rationale: ${decision.rationale}`];
  if (decision.alternatives?.length) parts.push(`alternatives: ${decision.alternatives.join(', ')}`);
  if (decision.confidence !== undefined) parts.push(`confidence: ${decision.confidence}`);
  return `${parts.join(', ')})`;
};

export async function handleChat(
  input: ChatInputT,
  ctx: BlendContext,
) {
  incMessages();
  const t0 = Date.now();

  const threadId = getThreadId(input.threadId);
  const trimmed = input.message.trim();

  ctx.log.debug({ 
    threadId, 
    messageLength: trimmed.length,
    message: trimmed.substring(0, 200),
    isWhy: /^\s*\/why\b/i.test(trimmed)
  }, '🔧 BLEND: Starting handleChat');

  if (!trimmed) {
    return ChatOutput.parse({
      reply: "I'm a travel assistant. Please share a travel question (weather, destinations, packing, attractions, flights, or policies).",
      threadId,
    });
  }

  const isWhy = /^\s*\/why\b/i.test(trimmed);

  if (isWhy) {
    ctx.log.debug({ threadId }, '🔧 BLEND: Processing /why command');
    const stored = (await getLastReceipts(threadId)) || {};
    const facts = stored.facts || [];
    const decisions = stored.decisions || [];
    const tokenEstimate = 400;
    const receipts = buildReceiptsSkeleton(facts as Fact[], decisions, tokenEstimate);

    const formatDecision = (d: string | Decision) => FORMAT_DECISION(d);

    try {
      const last = await getLastVerification(threadId);
      const audit = last
        ? { verdict: last.verdict, notes: last.notes || [], scores: last.scores, revisedAnswer: last.revisedAnswer }
        : { verdict: 'pass' as const, notes: ['No verification data available'], scores: undefined, revisedAnswer: undefined };

      const replyBody = audit.verdict === 'fail' && audit.revisedAnswer ? audit.revisedAnswer : stored.reply || 'No previous answer to explain.';
      const merged = { ...receipts, selfCheck: { verdict: audit.verdict, notes: audit.notes || [], scores: (audit as any)?.scores } };
      const safe = ReceiptsSchema.parse(merged);

      const receiptsReply = `--- RECEIPTS ---\n\nSources: ${receipts.sources.join(', ')}\n\nDecisions: ${decisions.map(formatDecision).join(' ')}\n\nSelf-Check: ${audit.verdict}${(audit.notes?.length || 0) > 0 ? ` (${audit.notes.join(', ')})` : ''}\n\nBudget: ${receipts.budgets.ext_api_latency_ms || 0}ms API, ~${tokenEstimate} tokens`
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

      incGeneratedAnswer();
      return ChatOutput.parse({ reply: receiptsReply, threadId, sources: receipts.sources, receipts: safe });
    } catch (error) {
      ctx.log.warn({ error: String(error), threadId }, 'why_command_failed');
      const fallback = `--- RECEIPTS ---\n\nSources: ${receipts.sources.join(', ')}\n\nDecisions: ${decisions.map(formatDecision).join(' ')}\n\nSelf-Check: not available\n\nBudget: ${receipts.budgets.ext_api_latency_ms || 0}ms API, ~${tokenEstimate} tokens`
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      incGeneratedAnswer();
      return ChatOutput.parse({ reply: fallback, threadId, sources: receipts.sources });
    }
  }

  ctx.onStatus?.('Processing your travel request...');
  await pushMessage(threadId, { role: 'user', content: trimmed });
  await setLastUserMessage(threadId, trimmed);

  ctx.log.debug({ threadId }, '🔧 BLEND: Getting slots before meta agent');
  const slotsBefore = await getThreadSlots(threadId);
  
  ctx.log.debug({ 
    threadId, 
    slotsBefore,
    slotsCount: Object.keys(slotsBefore).length
  }, '🔧 BLEND: Calling meta agent');
  
  const out = await runMetaAgentTurn(trimmed, threadId, { log: ctx.log });
  
  ctx.log.debug({ 
    threadId,
    replyLength: out.reply?.length || 0,
    reply: out.reply?.substring(0, 200),
    citationsCount: out.citations?.length || 0,
    citations: out.citations
  }, '🔧 BLEND: Meta agent completed');
  
  await pushMessage(threadId, { role: 'assistant', content: out.reply });
  incGeneratedAnswer();
  if (out.citations?.length) {
    incAnswersWithCitations();
    try { incAnswerUsingExternal(); } catch {}
  }

  // Auto-verify when requested (best-effort)
  const autoVerify = process.env.AUTO_VERIFY_REPLIES === 'true';
  let finalReply = out.reply;
  if (autoVerify) {
    ctx.log.debug({ threadId }, '🔧 BLEND: Starting auto-verification');
    try {
      const receiptsData = (await getLastReceipts(threadId)) || {};
      let facts = (receiptsData.facts || []) as Fact[];
      const intent = await getLastIntent(threadId);
      
      ctx.log.debug({ 
        threadId,
        factsCount: facts.length,
        intent,
        receiptsDataKeys: Object.keys(receiptsData)
      }, '🔧 BLEND: Auto-verify - initial facts check');
      
      if (facts.length === 0 && ['flights', 'destinations'].includes(intent || '')) {
        ctx.log.debug({ threadId, intent }, '🔧 BLEND: Auto-verify - waiting for facts to be written');
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const refreshed = await getLastReceipts(threadId);
          if ((refreshed?.facts?.length || 0) > 0) {
            facts = refreshed.facts as Fact[];
            ctx.log.debug({ 
              threadId, 
              attempt: i + 1, 
              factsCount: facts.length 
            }, '🔧 BLEND: Auto-verify - facts found after wait');
            break;
          }
        }
      }
      if ((!facts || facts.length === 0) && Array.isArray(out.citations) && out.citations.length > 0) {
        facts = out.citations.map((src, idx) => ({ source: String(src), key: `citation_${idx}`, value: 'source_only' }));
        ctx.log.debug({ 
          threadId, 
          factsFromCitations: facts.length 
        }, '🔧 BLEND: Auto-verify - created facts from citations');
      }

      const msgs = await getContext(threadId);
      const users = msgs.filter((m) => m.role === 'user').map((m) => m.content);
      const latestUser = users[users.length - 1] || trimmed;
      const previousUsers = users.slice(0, -1).slice(-2);

      ctx.log.debug({ 
        threadId,
        factsForVerification: facts.length,
        latestUser: latestUser.substring(0, 100),
        previousUsersCount: previousUsers.length
      }, '🔧 BLEND: Auto-verify - calling verifyAnswer');

      const vStart = Date.now();
      const audit = await verifyAnswer({
        reply: out.reply,
        facts: facts.map((f) => ({ key: f.key, value: f.value, source: String(f.source) })),
        log: ctx.log,
        latestUser,
        previousUsers,
        slotsSummary: { before: JSON.stringify(slotsBefore) },
        lastIntent: intent,
      });
      const vDur = Date.now() - vStart;

      ctx.log.debug({ 
        threadId,
        verdict: audit.verdict,
        notesCount: audit.notes?.length || 0,
        hasRevisedAnswer: !!audit.revisedAnswer
      }, '🔧 BLEND: Auto-verify - verification completed');

      // Verification metrics
      try {
        // Pass/fail/warn counters
        if (audit.verdict === 'fail') {
          const reason = (audit.notes?.[0] || 'fail').toLowerCase();
          incVerifyFail(reason);
          incVerificationRun('fail');
        } else if (audit.verdict === 'warn') {
          incVerificationRun('warn');
        } else {
          incVerifyPass();
          incVerificationRun('pass');
        }
        // Score distributions
        if ((audit as any)?.scores) {
          const s = (audit as any).scores as { relevance: number; grounding: number; coherence: number; context_consistency: number };
          observeVerifyScores(s);
        }
        // Stage latency + outcome
        const ok = audit.verdict !== 'fail';
        observeStage('verify', vDur, ok, intent || '');
        observeStageVerification('verify', intent || null, ok);
        // Confidence correlation
        const conf = typeof (audit as any)?.confidence === 'number'
          ? Math.max(0, Math.min(1, (audit as any).confidence))
          : (() => {
              const s = (audit as any)?.scores;
              if (!s) return 0;
              const avg = (s.relevance + s.grounding + s.coherence + s.context_consistency) / 4;
              return Math.max(0, Math.min(1, avg));
            })();
        observeConfidenceOutcome('verify', conf, ok, intent || '');
        try {
          const routerConf = getMetaRouteConfidence();
          observeConfidenceOutcome('router', routerConf, ok, intent || '');
        } catch {}
      } catch {}

      await setLastVerification(threadId, {
        verdict: audit.verdict,
        notes: audit.notes,
        revisedAnswer: audit.revisedAnswer,
        scores: (audit as any).scores,
      });

      if (audit.verdict === 'fail' && audit.revisedAnswer) {
        finalReply = audit.revisedAnswer;
        await pushMessage(threadId, { role: 'assistant', content: finalReply });
        ctx.log.debug({ threadId }, '🔧 BLEND: Auto-verify - using revised answer');
      }
    } catch (error) {
      ctx.log.error({ error: String(error), threadId }, '🔧 BLEND: Auto-verify failed');
    }
  }

  observeE2E(Date.now() - t0);
  
  ctx.log.debug({ 
    threadId,
    finalReplyLength: finalReply?.length || 0,
    citationsCount: out.citations?.length || 0,
    totalLatency: Date.now() - t0
  }, '🔧 BLEND: handleChat completed');
  
  return ChatOutput.parse({ reply: finalReply, threadId, citations: out.citations });
}
