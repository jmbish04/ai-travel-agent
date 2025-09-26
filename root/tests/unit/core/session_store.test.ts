import { createStore, initSessionStore, getSessionStore } from '../../../src/core/session_store.js';
import { loadSessionConfig } from '../../../src/config/session.js';

describe('SessionStore', () => {
  it('should create and initialize in-memory store', () => {
    const cfg = loadSessionConfig();
    const store = createStore(cfg);
    
    expect(store).toBeDefined();
    expect(typeof store.getMsgs).toBe('function');
    expect(typeof store.appendMsg).toBe('function');
    expect(typeof store.getSlots).toBe('function');
    expect(typeof store.setSlots).toBe('function');
  });

  it('should throw error when accessing uninitialized store', () => {
    // Reset global store
    const cfg = loadSessionConfig();
    const store = createStore(cfg);
    
    expect(() => getSessionStore()).toThrow('Session store not initialized');
    
    // Restore
    initSessionStore(store);
  });

  it('should store and retrieve messages', async () => {
    const cfg = loadSessionConfig();
    const store = createStore(cfg);
    
    const testMsg = { role: 'user' as const, content: 'test message' };
    
    await store.appendMsg('test-id', testMsg);
    const messages = await store.getMsgs('test-id');
    
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(testMsg);
  });

  it('should store and retrieve slots', async () => {
    const cfg = loadSessionConfig();
    const store = createStore(cfg);
    
    await store.setSlots('test-id', { key1: 'value1', key2: 'value2' });
    const slots = await store.getSlots('test-id');
    
    expect(slots).toEqual({ key1: 'value1', key2: 'value2' });
  });

  it('should store and retrieve JSON data', async () => {
    const cfg = loadSessionConfig();
    const store = createStore(cfg);
    
    const testData = { nested: { value: 42 }, array: [1, 2, 3] };
    
    await store.setJson('test-key', 'test-id', testData);
    const retrieved = await store.getJson('test-key', 'test-id');
    
    expect(retrieved).toEqual(testData);
  });
});
