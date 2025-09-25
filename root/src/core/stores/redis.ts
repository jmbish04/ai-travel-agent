import type { SessionStore, Msg } from '../session_store.js';
import type { SessionConfig } from '../../config/session.js';

// Type-only import to avoid runtime dependency when redis not installed
type RedisClientType = any;

export function createRedisStore(
  cfg: SessionConfig,
  injectedClient?: RedisClientType,
): SessionStore {
  let client: RedisClientType;

  async function getClient(): Promise<RedisClientType> {
    if (client) return client;

    if (injectedClient) {
      client = injectedClient;
      return client;
    }

    try {
      const { createClient } = await import('redis');
      client = createClient({ url: cfg.redisUrl });
      await client.connect();
      return client;
    } catch (error) {
      throw new Error(`Failed to connect to Redis: ${error}`);
    }
  }

  async function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs = cfg.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await operation();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    async getMsgs(id: string, limit?: number): Promise<Msg[]> {
      return withTimeout(async () => {
        const redis = await getClient();
        const key = `chat:${id}:msgs`;
        const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
        const end = hasLimit ? limit - 1 : -1;
        const msgs = await redis.lRange(key, 0, end);
        return msgs.reverse().map((m: string) => JSON.parse(m));
      });
    },

    async appendMsg(id: string, msg: Msg, limit?: number): Promise<void> {
      return withTimeout(async () => {
        const redis = await getClient();
        const key = `chat:${id}:msgs`;
        const multi = redis.multi();
        multi.lPush(key, JSON.stringify(msg));
        if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
          multi.lTrim(key, 0, limit - 1);
        }
        multi.expire(key, cfg.ttlSec);
        await multi.exec();
      });
    },

    async getSlots(id: string): Promise<Record<string, string>> {
      return withTimeout(async () => {
        const redis = await getClient();
        const key = `chat:${id}:slots`;
        const slots = await redis.hGetAll(key);
        return slots || {};
      });
    },

    async setSlots(id: string, patch: Record<string, string>, remove?: string[]): Promise<void> {
      return withTimeout(async () => {
        const redis = await getClient();
        const key = `chat:${id}:slots`;
        const multi = redis.multi();

        if (Object.keys(patch).length > 0) {
          multi.hSet(key, patch);
        }
        if (remove && remove.length > 0) {
          multi.hDel(key, remove);
        }
        multi.expire(key, cfg.ttlSec);
        await multi.exec();
      });
    },

    async getJson<T>(key: string, id: string): Promise<T | undefined> {
      return withTimeout(async () => {
        const redis = await getClient();
        const redisKey = `chat:${id}:kv:${key}`;
        const value = await redis.get(redisKey);
        return value ? JSON.parse(value) : undefined;
      });
    },

    async setJson<T>(key: string, id: string, value: T): Promise<void> {
      return withTimeout(async () => {
        const redis = await getClient();
        const redisKey = `chat:${id}:kv:${key}`;
        const multi = redis.multi();
        multi.set(redisKey, JSON.stringify(value));
        multi.pExpire(redisKey, cfg.ttlSec * 1000);
        await multi.exec();
      });
    },

    async expire(id: string, ttlSec: number): Promise<void> {
      return withTimeout(async () => {
        const redis = await getClient();
        const keys = [`chat:${id}:msgs`, `chat:${id}:slots`];
        const multi = redis.multi();
        for (const key of keys) {
          multi.expire(key, ttlSec);
        }
        await multi.exec();
      });
    },

    async clear(id: string): Promise<void> {
      return withTimeout(async () => {
        const redis = await getClient();
        const pattern = `chat:${id}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(keys);
        }
      });
    },
  };
}

export async function ping(cfg: SessionConfig, client?: RedisClientType): Promise<boolean> {
  try {
    if (cfg.kind !== 'redis') return true;

    let redis = client;
    if (!redis) {
      const { createClient } = await import('redis');
      redis = createClient({ url: cfg.redisUrl });
      await redis.connect();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      await redis.ping();
      return true;
    } finally {
      clearTimeout(timeoutId);
      if (!client) {
        await redis.quit();
      }
    }
  } catch {
    return false;
  }
}
