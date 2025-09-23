import type { Router } from 'express';
import express from 'express';
import type pino from 'pino';
import { ChatInput, ChatOutput } from '../schemas/chat.js';
import { handleChat } from '../core/blend.js';
import { getPrometheusText, metricsMode, snapshot, snapshotV2, observeE2E, ingestEvent, incVerifyFail, incVerifyPass } from '../util/metrics.js';
import { buildReceiptsSkeleton, ReceiptsSchema } from '../core/receipts.js';
import { getLastReceipts, getLastVerification } from '../core/slot_memory.js';
import { verifyAnswer } from '../core/verify.js';

export const router = (log: pino.Logger): Router => {
  const r = express.Router();
  r.post('/chat', async (req, res) => {
    const parsed = ChatInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    try {
      const t0 = Date.now();
      const out = await handleChat(parsed.data, { log });
      // e2e latency
      observeE2E(Date.now() - t0);
      // Build receipts only when requested via flag or '/why' command
      const wantReceipts = Boolean(parsed.data.receipts) ||
        /^\s*\/why\b/i.test(parsed.data.message);
      if (!wantReceipts) {
        return res.json(out);
      }
      // If handleChat already produced receipts, avoid recomputing
      if ((out as any).receipts) {
        return res.json(out);
      }
      const receiptsData = await getLastReceipts(out.threadId) || {};
      const facts = receiptsData.facts || [];
      const decisions = receiptsData.decisions || [];
      const lastReply = receiptsData.reply;
      const token_estimate = 400;
      const receipts = buildReceiptsSkeleton(facts, decisions, token_estimate);
      // Prefer stored auto-verify artifact when enabled
      const auto = process.env.AUTO_VERIFY_REPLIES === 'true';
      if (auto) {
        try {
          const artifact = await getLastVerification(out.threadId);
          if (artifact) {
            const merged = {
              ...receipts,
              selfCheck: { verdict: artifact.verdict, notes: artifact.notes || [], scores: artifact.scores }
            };
            const safe = ReceiptsSchema.parse(merged);
            const response = {
              ...out,
              reply: out.reply,
              sources: receipts.sources,
              receipts: safe
            };
            return res.json(ChatOutput.parse(response));
          }
        } catch {}
      }
      // Self-check second pass (fallback when no artifact)
      try {
        const audit = await verifyAnswer({
          reply: lastReply ?? out.reply,
          facts: facts as Array<{ key: string; value: unknown; source: string }>,
          log
        });
        // verification metrics
        if (audit.verdict === 'fail') {
          const reason = (audit.notes?.[0] || 'fail').toLowerCase();
          incVerifyFail(reason);
        } else {
          incVerifyPass();
        }
        const merged = {
          ...receipts,
          selfCheck: { verdict: audit.verdict, notes: audit.notes, scores: (audit as any).scores }
        };
        let finalReply = out.reply;
        if (audit.verdict === 'fail' && audit.revisedAnswer) {
          finalReply = audit.revisedAnswer;
        }
        const safe = ReceiptsSchema.parse(merged);
        const response = {
          ...out,
          reply: finalReply,
          sources: receipts.sources,
          receipts: safe
        };
        return res.json(ChatOutput.parse(response));
      } catch {
        // If receipts generation fails, return normal response
        return res.json(out);
      }
    } catch (err: unknown) {
      log.error({ err }, 'chat failed');
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  // Optional /metrics endpoint
  r.get('/metrics', async (req, res) => {
    const mode = metricsMode();
    if (mode === 'prom') {
      const text = await getPrometheusText();
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      return res.status(200).send(text);
    }
    // JSON mode: v2 by default; legacy via query
    const legacy = String(req.query.mode || '').toLowerCase() === 'legacy';
    return res.json(legacy ? snapshot() : snapshotV2());
  });

  // Lightweight ingest endpoint to merge CLI/off-process metrics
  r.post('/metrics/ingest', express.json(), (req, res) => {
    try {
      const { name, labels, value } = (req.body || {}) as { name: string; labels?: Record<string, string>; value?: number };
      if (!name) return res.status(400).json({ error: 'missing name' });
      ingestEvent(name, labels, value);
      return res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'metrics_ingest_failed');
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  return r;
};
