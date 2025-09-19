import type { SessionConfig } from '../config/session.js';
import { createInMemoryStore } from './stores/inmemory.js';
import { createRedisStore } from './stores/redis.js';
import type { RedisClientType } from 'redis';

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
}

export const MAX_MESSAGES = 16;

const storeSymbol = Symbol('sessionStore');
let globalStore: SessionStore | undefined;

export function createStore(
  cfg: SessionConfig,
  deps?: { redisClient?: RedisClientType },
): SessionStore {
  return cfg.kind === 'redis'
    ? createRedisStore(cfg, deps?.redisClient)
    : createInMemoryStore(cfg);
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
