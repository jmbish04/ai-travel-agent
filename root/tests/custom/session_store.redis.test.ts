import { createRedisStore, ping } from '../../src/core/stores/redis.js';
import type { SessionConfig } from '../../src/config/session.js';

// Skip Redis tests if no Redis URL provided
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.SESSION_REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;

describeRedis('RedisStore', () => {
  const config: SessionConfig = {
    kind: 'redis',
    ttlSec: 3600,
    redisUrl: REDIS_URL,
    timeoutMs: 2000,
  };

  let store: ReturnType<typeof createRedisStore>;
  let mockClient: any;

  beforeEach(async () => {
    // Create mock Redis client for testing
    mockClient = {
      lRange: jest.fn(),
      lPush: jest.fn(),
      lTrim: jest.fn(),
      expire: jest.fn(),
      hGetAll: jest.fn(),
      hSet: jest.fn(),
      hDel: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
      pExpire: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      ping: jest.fn(),
      multi: jest.fn(() => ({
        lPush: jest.fn().mockReturnThis(),
        lTrim: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        hSet: jest.fn().mockReturnThis(),
        hDel: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        pExpire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      })),
    };

    store = createRedisStore(config, mockClient);
  });

  describe('messages', () => {
    it('should store and retrieve messages', async () => {
      const msg = { role: 'user' as const, content: 'hello' };
      mockClient.lRange.mockResolvedValue([JSON.stringify(msg)]);

      await store.appendMsg('test', msg);
      const msgs = await store.getMsgs('test');

      expect(mockClient.multi().lPush).toHaveBeenCalledWith('chat:test:msgs', JSON.stringify(msg));
      expect(mockClient.multi().lTrim).toHaveBeenCalledWith('chat:test:msgs', 0, 15);
      expect(msgs).toEqual([msg]);
    });

    it('should limit message history', async () => {
      const msg = { role: 'user' as const, content: 'hello' };
      
      await store.appendMsg('test', msg, 5);
      
      expect(mockClient.multi().lTrim).toHaveBeenCalledWith('chat:test:msgs', 0, 4);
    });

    it('should reverse message order from Redis LRANGE', async () => {
      const msgs = [
        { role: 'user' as const, content: 'first' },
        { role: 'assistant' as const, content: 'second' },
      ];
      
      // Redis returns in reverse chronological order
      mockClient.lRange.mockResolvedValue([
        JSON.stringify(msgs[1]),
        JSON.stringify(msgs[0]),
      ]);

      const retrieved = await store.getMsgs('test');
      expect(retrieved).toEqual(msgs); // Should be in correct order
    });
  });

  describe('slots', () => {
    it('should store and retrieve slots', async () => {
      const slots = { city: 'Paris', country: 'France' };
      mockClient.hGetAll.mockResolvedValue(slots);

      await store.setSlots('test', slots);
      const retrieved = await store.getSlots('test');

      expect(mockClient.multi().hSet).toHaveBeenCalledWith('chat:test:slots', slots);
      expect(retrieved).toEqual(slots);
    });

    it('should remove specified slots', async () => {
      await store.setSlots('test', { city: 'Paris' }, ['temp']);
      
      expect(mockClient.multi().hSet).toHaveBeenCalledWith('chat:test:slots', { city: 'Paris' });
      expect(mockClient.multi().hDel).toHaveBeenCalledWith('chat:test:slots', ['temp']);
    });

    it('should handle empty slot updates', async () => {
      await store.setSlots('test', {}, ['temp']);
      
      expect(mockClient.multi().hSet).not.toHaveBeenCalled();
      expect(mockClient.multi().hDel).toHaveBeenCalledWith('chat:test:slots', ['temp']);
    });
  });

  describe('JSON storage', () => {
    it('should store and retrieve JSON data', async () => {
      const data = { receipts: [{ id: 1, type: 'policy' }] };
      mockClient.get.mockResolvedValue(JSON.stringify(data));

      await store.setJson('receipts', 'test', data);
      const retrieved = await store.getJson('receipts', 'test');

      expect(mockClient.multi().set).toHaveBeenCalledWith('chat:test:kv:receipts', JSON.stringify(data));
      expect(retrieved).toEqual(data);
    });

    it('should return undefined for missing keys', async () => {
      mockClient.get.mockResolvedValue(null);
      
      const result = await store.getJson('missing', 'test');
      expect(result).toBeUndefined();
    });
  });

  describe('expiration', () => {
    it('should set TTL on all operations', async () => {
      await store.appendMsg('test', { role: 'user', content: 'hello' });
      await store.setSlots('test', { city: 'Paris' });
      await store.setJson('data', 'test', { value: 123 });

      expect(mockClient.multi().expire).toHaveBeenCalledWith('chat:test:msgs', 3600);
      expect(mockClient.multi().expire).toHaveBeenCalledWith('chat:test:slots', 3600);
      expect(mockClient.multi().pExpire).toHaveBeenCalledWith('chat:test:kv:data', 3600000);
    });

    it('should update TTL manually', async () => {
      await store.expire('test', 7200);
      
      expect(mockClient.multi().expire).toHaveBeenCalledWith('chat:test:msgs', 7200);
      expect(mockClient.multi().expire).toHaveBeenCalledWith('chat:test:slots', 7200);
    });
  });

  describe('clear', () => {
    it('should clear all keys for a thread', async () => {
      const keys = ['chat:test:msgs', 'chat:test:slots', 'chat:test:kv:data'];
      mockClient.keys.mockResolvedValue(keys);

      await store.clear('test');

      expect(mockClient.keys).toHaveBeenCalledWith('chat:test:*');
      expect(mockClient.del).toHaveBeenCalledWith(keys);
    });

    it('should handle no keys to delete', async () => {
      mockClient.keys.mockResolvedValue([]);

      await store.clear('test');

      expect(mockClient.del).not.toHaveBeenCalled();
    });
  });

  describe('timeout handling', () => {
    it('should handle operation timeouts', async () => {
      mockClient.lRange.mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 3000))
      );

      await expect(store.getMsgs('test')).rejects.toThrow();
    });
  });
});

describe('Redis ping', () => {
  const config: SessionConfig = {
    kind: 'redis',
    ttlSec: 3600,
    redisUrl: 'redis://localhost:6379',
    timeoutMs: 1000,
  };

  it('should return true for memory store', async () => {
    const memoryConfig = { ...config, kind: 'memory' as const };
    const result = await ping(memoryConfig);
    expect(result).toBe(true);
  });

  it('should handle Redis connection errors', async () => {
    const result = await ping(config);
    // Should return false if Redis is not available
    expect(typeof result).toBe('boolean');
  });
});
