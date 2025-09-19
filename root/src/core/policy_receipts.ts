import type { PolicyReceipt } from '../schemas/policy.js';
import { getSessionStore } from './session_store.js';

export async function savePolicyReceipt(threadId: string, receipt: PolicyReceipt): Promise<void> {
  const store = getSessionStore();
  const existing = await store.getJson<PolicyReceipt[]>('policy_receipts', threadId) || [];
  existing.push(receipt);
  await store.setJson('policy_receipts', threadId, existing);
}

export async function getPolicyReceipts(threadId: string): Promise<PolicyReceipt[]> {
  const store = getSessionStore();
  return await store.getJson<PolicyReceipt[]>('policy_receipts', threadId) || [];
}

export async function clearPolicyReceipts(threadId: string): Promise<void> {
  const store = getSessionStore();
  await store.setJson('policy_receipts', threadId, []);
}
