/**
 * Integration test for session store TTL and eviction behavior
 * Tests Redis EXPIRE behavior using ioredis-mock
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { createStore } from '../../src/core/session_store.js';

describe('Session Store Eviction', () => {
  test('should evict expired entries in memory store', async () => {
    const store = createStore({
      kind: 'memory',
      ttlSec: 1 // Very short TTL for testing
    });

    const threadId = 'test-thread-eviction';
    
    // Store a message
    await store.appendMsg(threadId, { role: 'user', content: 'test message' });
    
    // Should exist immediately
    const messages = await store.getMsgs(threadId);
    expect(messages).toHaveLength(1);
    
    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 1100));
    
    // Should be evicted
    const expiredMessages = await store.getMsgs(threadId);
    expect(expiredMessages).toHaveLength(0);
  });

  test('should handle Redis TTL when using Redis store', async () => {
    // Skip if not using Redis
    if (process.env.SESSION_STORE !== 'redis') {
      return;
    }

    const store = createStore({
      kind: 'redis',
      ttlSec: 2,
      redisUrl: process.env.SESSION_REDIS_URL || 'redis://localhost:6379'
    });

    const threadId = 'test-thread-redis-ttl';
    
    try {
      // Store a message
      await store.appendMsg(threadId, { role: 'user', content: 'redis test' });
      
      // Should exist immediately
      const messages = await store.getMsgs(threadId);
      expect(messages).toHaveLength(1);
      
      // Wait for TTL
      await new Promise(resolve => setTimeout(resolve, 2100));
      
      // Should be expired
      const expiredMessages = await store.getMsgs(threadId);
      expect(expiredMessages).toHaveLength(0);
    } finally {
      // Cleanup
      await store.clear(threadId);
    }
  });

  test('should handle bounded history in memory store', async () => {
    const store = createStore({
      kind: 'memory',
      ttlSec: 300
    });

    const threadId = 'test-thread-bounded';
    
    // Add more messages than MAX_MESSAGES (16)
    for (let i = 0; i < 20; i++) {
      await store.appendMsg(threadId, { 
        role: i % 2 === 0 ? 'user' : 'assistant', 
        content: `message ${i}` 
      });
    }
    
    // Should be bounded to MAX_MESSAGES
    const messages = await store.getMsgs(threadId);
    expect(messages.length).toBeLessThanOrEqual(16);
    
    // Should keep most recent messages
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.content).toContain('19');
  });
});
