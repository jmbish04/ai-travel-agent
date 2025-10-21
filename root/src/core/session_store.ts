import type { SessionConfig } from '../config/session.js';
import { createInMemoryStore } from './stores/inmemory.js';
import { createCloudflareStore, type CloudflareStoreDependencies } from './stores/cloudflare.js';

export type Msg = { role: 'user' | 'assistant' | 'system'; content: string };

export interface SessionStore {
  getMsgs(id: string, limit?: number): Promise<Msg[]>;
  appendMsg(id: string, msg: Msg, limit?: number): Promise<void>;
  getSlots(id: string): Promise<Record<string, string>>;
  setSlots(id: string, patch: Record<string, string>, remove?: string[]): Promise<void>;
  getJson<T = unknown>(key: string, id: string): Promise<T | undefined>;
  setJson<T = unknown>(key: string, id: string, value: T): Promise<void>;
  expire(id: string, ttlSec: number): Promise<void>;
  clear(id: string): Promise<void>;
  healthCheck?(): Promise<boolean>;
}

const rawMax = Number(process.env.SESSION_MAX_MESSAGES ?? '0');
export const MAX_MESSAGES = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : undefined;

const storeSymbol = Symbol('sessionStore');
let globalStore: SessionStore | undefined;

export function createStore(
  cfg: SessionConfig,
  deps?: { cloudflare?: CloudflareStoreDependencies },
): SessionStore {
  if (cfg.kind === 'cloudflare') {
    if (!deps?.cloudflare) {
      console.warn('Cloudflare session store requested but no bindings provided. Falling back to in-memory store.');
      return createInMemoryStore(cfg);
    }
    return createCloudflareStore(cfg, deps.cloudflare);
  }

  return createInMemoryStore(cfg);
}

export function initSessionStore(store: SessionStore): void {
  globalStore = store;
}

export function getSessionStore(): SessionStore {
  if (!globalStore) {
    throw new Error('Session store not initialized. Call initSessionStore() first.');
  }
  return globalStore;
}

export function resetSessionStoreForTests(store: SessionStore): void {
  globalStore = store;
}
