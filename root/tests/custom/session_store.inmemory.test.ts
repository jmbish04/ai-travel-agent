import { createInMemoryStore } from '../../src/core/stores/inmemory.js';
import type { SessionConfig } from '../../src/config/session.js';

describe('InMemoryStore', () => {
  const config: SessionConfig = {
    kind: 'memory',
    ttlSec: 1, // Short TTL for testing
    timeoutMs: 1000,
  };

  let store: ReturnType<typeof createInMemoryStore>;

  beforeEach(() => {
    store = createInMemoryStore(config);
  });

  describe('messages', () => {
    it('should store and retrieve messages', async () => {
      const msg = { role: 'user' as const, content: 'hello' };
      await store.appendMsg('test', msg);
      
      const msgs = await store.getMsgs('test');
      expect(msgs).toEqual([msg]);
    });

    it('should limit message history', async () => {
      const msgs = Array.from({ length: 20 }, (_, i) => ({
        role: 'user' as const,
        content: `msg ${i}`,
      }));

      for (const msg of msgs) {
        await store.appendMsg('test', msg, 5);
      }

      const retrieved = await store.getMsgs('test');
      expect(retrieved).toHaveLength(5);
      expect(retrieved[0].content).toBe('msg 15'); // Oldest kept
      expect(retrieved[4].content).toBe('msg 19'); // Newest
    });

    it('should respect limit parameter in getMsgs', async () => {
      const msgs = Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: `msg ${i}`,
      }));

      for (const msg of msgs) {
        await store.appendMsg('test', msg);
      }

      const limited = await store.getMsgs('test', 3);
      expect(limited).toHaveLength(3);
      expect(limited[2].content).toBe('msg 9'); // Most recent
    });
  });

  describe('slots', () => {
    it('should store and retrieve slots', async () => {
      await store.setSlots('test', { city: 'Paris', country: 'France' });
      
      const slots = await store.getSlots('test');
      expect(slots).toEqual({ city: 'Paris', country: 'France' });
    });

    it('should merge slot updates', async () => {
      await store.setSlots('test', { city: 'Paris' });
      await store.setSlots('test', { country: 'France' });
      
      const slots = await store.getSlots('test');
      expect(slots).toEqual({ city: 'Paris', country: 'France' });
    });

    it('should remove specified slots', async () => {
      await store.setSlots('test', { city: 'Paris', country: 'France', temp: 'hot' });
      await store.setSlots('test', {}, ['temp']);
      
      const slots = await store.getSlots('test');
      expect(slots).toEqual({ city: 'Paris', country: 'France' });
    });
  });

  describe('JSON storage', () => {
    it('should store and retrieve JSON data', async () => {
      const data = { receipts: [{ id: 1, type: 'policy' }] };
      await store.setJson('receipts', 'test', data);
      
      const retrieved = await store.getJson('receipts', 'test');
      expect(retrieved).toEqual(data);
    });

    it('should return undefined for missing keys', async () => {
      const result = await store.getJson('missing', 'test');
      expect(result).toBeUndefined();
    });
  });

  describe('TTL and expiration', () => {
    it('should expire entries after TTL', async () => {
      await store.appendMsg('test', { role: 'user', content: 'hello' });
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      const msgs = await store.getMsgs('test');
      expect(msgs).toEqual([]); // Should be empty after expiration
    });

    it('should update TTL on access', async () => {
      await store.appendMsg('test', { role: 'user', content: 'hello' });
      
      // Access before expiration to refresh TTL
      await new Promise(resolve => setTimeout(resolve, 500));
      await store.getMsgs('test');
      
      // Wait another 700ms (total 1200ms, but TTL was refreshed at 500ms)
      await new Promise(resolve => setTimeout(resolve, 700));
      
      const msgs = await store.getMsgs('test');
      expect(msgs).toHaveLength(1); // Should still exist
    });

    it('should allow manual expiration updates', async () => {
      await store.appendMsg('test', { role: 'user', content: 'hello' });
      await store.expire('test', 2); // Extend to 2 seconds
      
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      const msgs = await store.getMsgs('test');
      expect(msgs).toHaveLength(1); // Should still exist with extended TTL
    });
  });

  describe('clear', () => {
    it('should clear all data for a thread', async () => {
      await store.appendMsg('test', { role: 'user', content: 'hello' });
      await store.setSlots('test', { city: 'Paris' });
      await store.setJson('data', 'test', { value: 123 });
      
      await store.clear('test');
      
      const msgs = await store.getMsgs('test');
      const slots = await store.getSlots('test');
      const json = await store.getJson('data', 'test');
      
      expect(msgs).toEqual([]);
      expect(slots).toEqual({});
      expect(json).toBeUndefined();
    });
  });
});
