import { getSessionStore, MAX_MESSAGES, type Msg } from './session_store.js';

export function getThreadId(provided?: string) {
  const id = (provided || '').trim();
  if (id) {
    // Enforce max length to satisfy schema and avoid runtime errors
    return id.length > 64 ? id.slice(0, 64) : id;
  }
  return Math.random().toString(36).slice(2, 10);
}

export async function pushMessage(threadId: string, msg: Msg): Promise<void> {
  const store = getSessionStore();
  await store.appendMsg(threadId, msg, MAX_MESSAGES);
}

export async function getContext(threadId: string): Promise<Msg[]> {
  const store = getSessionStore();
  return store.getMsgs(threadId);
}

