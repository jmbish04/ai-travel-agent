import { getLastReceipts, getLastVerification } from '../../src/core/slot_memory.js';
import { buildReceiptsSkeleton } from '../../src/core/receipts.js';
import { verifyAnswer } from '../../src/core/verify.js';

export async function fetchLastReceipts(threadId: string) {
  const data = await getLastReceipts(threadId);
  const facts = data?.facts || [];
  const decisions = data?.decisions || [];
  const receipts = buildReceiptsSkeleton(facts as any, decisions as any, 400);
  return { facts, decisions, receipts, reply: data?.reply };
}

export async function fetchLastVerification(threadId: string) {
  return await getLastVerification(threadId);
}

export async function ensureVerified(opts: {
  threadId: string;
  reply: string;
  latestUser: string;
  previousUsers?: string[];
  lastIntent?: string;
}) {
  const allowNetwork = process.env.VERIFY_LLM === '1' || process.env.VERIFY_LLM === 'true';
  if (!allowNetwork) {
    // Skip explicit verify; tests should check skipping conditions
    return { verdict: 'warn', notes: ['skipped_no_llm'] } as const;
  }
  const { facts } = await fetchLastReceipts(opts.threadId);
  const res = await verifyAnswer({
    reply: opts.reply,
    facts: (facts || []).map((f: any, i: number) => ({
      key: f.key || `k${i}`,
      value: f.value ?? 'source_only',
      source: String(f.source || 'unknown')
    })),
    latestUser: opts.latestUser,
    previousUsers: opts.previousUsers || [],
    lastIntent: opts.lastIntent || '',
  } as any);
  return res;
}

