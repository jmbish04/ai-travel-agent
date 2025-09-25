import type { SessionStore, Msg } from '../session_store.js';
import type { SessionConfig } from '../../config/session.js';

interface Entry {
  msgs: Msg[];
  slots: Record<string, string>;
  kv: Record<string, unknown>;
  expiresAt: number;
}

export function createInMemoryStore(cfg: SessionConfig): SessionStore {
  const store = new Map<string, Entry>();
  const ttlMs = cfg.ttlSec * 1000;

  // Start sweeper
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of store.entries()) {
      if (entry.expiresAt <= now) {
        store.delete(id);
      }
    }
  }, 60_000);

  // Cleanup on process exit
  process.on('exit', () => clearInterval(sweepInterval));

  function getEntry(id: string): Entry {
    const entry = store.get(id);
    if (!entry || entry.expiresAt <= Date.now()) {
      const fresh = { msgs: [], slots: {}, kv: {}, expiresAt: Date.now() + ttlMs };
      store.set(id, fresh);
      return fresh;
    }
    return entry;
  }

  function touch(id: string): void {
    const entry = store.get(id);
    if (entry) {
      entry.expiresAt = Date.now() + ttlMs;
    }
  }

  return {
    async getMsgs(id: string, limit?: number): Promise<Msg[]> {
      const entry = getEntry(id);
      touch(id);
      if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        return entry.msgs.slice(-limit);
      }
      return [...entry.msgs];
    },

    async appendMsg(id: string, msg: Msg, limit?: number): Promise<void> {
      const entry = getEntry(id);
      entry.msgs.push(msg);
      if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        while (entry.msgs.length > limit) {
          entry.msgs.shift();
        }
      }
      touch(id);
    },

    async getSlots(id: string): Promise<Record<string, string>> {
      const entry = getEntry(id);
      touch(id);
      return { ...entry.slots };
    },

    async setSlots(id: string, patch: Record<string, string>, remove?: string[]): Promise<void> {
      const entry = getEntry(id);
      Object.assign(entry.slots, patch);
      if (remove) {
        for (const key of remove) {
          delete entry.slots[key];
        }
      }
      touch(id);
    },

    async getJson<T>(key: string, id: string): Promise<T | undefined> {
      const entry = getEntry(id);
      touch(id);
      return entry.kv[key] as T | undefined;
    },

    async setJson<T>(key: string, id: string, value: T): Promise<void> {
      const entry = getEntry(id);
      entry.kv[key] = value;
      touch(id);
    },

    async expire(id: string, ttlSec: number): Promise<void> {
      const entry = store.get(id);
      if (entry) {
        entry.expiresAt = Date.now() + (ttlSec * 1000);
      }
    },

    async clear(id: string): Promise<void> {
      store.delete(id);
    },
  };
}
