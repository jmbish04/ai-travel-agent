import type { SessionConfig } from '../../config/session.js';
import type { Msg, SessionStore } from '../session_store.js';
import { CloudflareStorageAdapter, type CloudflareBindings } from '../cloudflare-storage-adapter.js';
import type { StorageAdapter } from '../storage-adapter.js';

export interface CloudflareStoreDependencies {
  adapter?: StorageAdapter;
  bindings?: CloudflareBindings;
}

export function createCloudflareStore(
  cfg: SessionConfig,
  deps: CloudflareStoreDependencies,
): SessionStore {
  if (!deps.adapter && !deps.bindings) {
    throw new Error('Cloudflare storage requires bindings or an adapter instance');
  }

  const adapter = deps.adapter ?? new CloudflareStorageAdapter(deps.bindings!, { ttlSec: cfg.ttlSec });

  const withThreadSession = async (threadId: string): Promise<void> => {
    const existing = await adapter.getSession(threadId);
    if (!existing) {
      await adapter.createSession({
        id: threadId,
        threadId,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        expiresAt: Math.floor(Date.now() / 1000) + cfg.ttlSec,
      });
    } else {
      await adapter.updateSession(threadId, { lastAccessedAt: Date.now() });
    }
  };

  return {
    async getMsgs(id: string, limit?: number): Promise<Msg[]> {
      await withThreadSession(id);
      return adapter.getMessages(id, limit);
    },

    async appendMsg(id: string, msg: Msg, limit?: number): Promise<void> {
      await withThreadSession(id);
      await adapter.appendMessage(id, msg, limit);
    },

    async getSlots(id: string): Promise<Record<string, string>> {
      await withThreadSession(id);
      return adapter.getSlots(id);
    },

    async setSlots(id: string, patch: Record<string, string>, remove?: string[]): Promise<void> {
      await withThreadSession(id);
      await adapter.setSlots(id, patch, remove);
    },

    async getJson<T>(key: string, id: string): Promise<T | undefined> {
      await withThreadSession(id);
      const value = await adapter.getThreadJson<T>(id, key);
      return value ?? undefined;
    },

    async setJson<T>(key: string, id: string, value: T): Promise<void> {
      await withThreadSession(id);
      await adapter.setThreadJson(id, key, value);
    },

    async expire(id: string, ttlSec: number): Promise<void> {
      await adapter.expireThread(id, ttlSec);
    },

    async clear(id: string): Promise<void> {
      await adapter.clearThread(id);
    },

    async healthCheck(): Promise<boolean> {
      if (typeof adapter.healthCheck !== 'function') return true;
      return adapter.healthCheck();
    },
  };
}
