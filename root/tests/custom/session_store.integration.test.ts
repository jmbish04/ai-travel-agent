import { loadSessionConfig } from '../../src/config/session.js';
import { createStore, initSessionStore, resetSessionStoreForTests } from '../../src/core/session_store.js';
import { getThreadSlots, updateThreadSlots } from '../../src/core/slot_memory.js';
import { pushMessage, getContext } from '../../src/core/memory.js';

// Skip Redis integration tests if no Redis URL provided
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.SESSION_REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;

describe('Session Store Integration', () => {
  describe('Memory Store', () => {
    beforeEach(() => {
      const config = { kind: 'memory' as const, ttlSec: 3600, timeoutMs: 1000 };
      const store = createStore(config);
      resetSessionStoreForTests(store);
    });

    it('should maintain context across function calls', async () => {
      const threadId = 'test-thread';
      
      // Add message and slots
      await pushMessage(threadId, { role: 'user', content: 'Hello' });
      await updateThreadSlots(threadId, { city: 'Paris' });
      
      // Retrieve and verify
      const messages = await getContext(threadId);
      const slots = await getThreadSlots(threadId);
      
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello');
      expect(slots.city).toBe('Paris');
    });

    it('should handle message history limits', async () => {
      const threadId = 'test-thread';
      
      // Add more messages than the limit
      for (let i = 0; i < 20; i++) {
        await pushMessage(threadId, { role: 'user', content: `Message ${i}` });
      }
      
      const messages = await getContext(threadId);
      expect(messages.length).toBeLessThanOrEqual(16); // MAX_MESSAGES
      expect(messages[messages.length - 1].content).toBe('Message 19'); // Latest message
    });
  });

  describeRedis('Redis Store', () => {
    beforeEach(() => {
      const config = { 
        kind: 'redis' as const, 
        ttlSec: 3600, 
        redisUrl: REDIS_URL!,
        timeoutMs: 2000 
      };
      const store = createStore(config);
      resetSessionStoreForTests(store);
    });

    it('should maintain context across function calls with Redis', async () => {
      const threadId = 'test-redis-thread';
      
      // Add message and slots
      await pushMessage(threadId, { role: 'user', content: 'Hello Redis' });
      await updateThreadSlots(threadId, { city: 'London' });
      
      // Retrieve and verify
      const messages = await getContext(threadId);
      const slots = await getThreadSlots(threadId);
      
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello Redis');
      expect(slots.city).toBe('London');
    });

    it('should persist data across store recreations', async () => {
      const threadId = 'test-persistence';
      const config = { 
        kind: 'redis' as const, 
        ttlSec: 3600, 
        redisUrl: REDIS_URL!,
        timeoutMs: 2000 
      };
      
      // First store instance
      let store = createStore(config);
      resetSessionStoreForTests(store);
      
      await pushMessage(threadId, { role: 'user', content: 'Persistent message' });
      await updateThreadSlots(threadId, { destination: 'Tokyo' });
      
      // Create new store instance (simulating restart)
      store = createStore(config);
      resetSessionStoreForTests(store);
      
      // Data should still be there
      const messages = await getContext(threadId);
      const slots = await getThreadSlots(threadId);
      
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Persistent message');
      expect(slots.destination).toBe('Tokyo');
      
      // Cleanup
      await store.clear(threadId);
    });
  });
});
