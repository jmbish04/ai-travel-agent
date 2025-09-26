import { createStore, initSessionStore, getSessionStore, resetSessionStoreForTests } from '../../../src/core/session_store.js';
import { loadSessionConfig } from '../../../src/config/session.js';

describe('SessionStore', () => {
  const stores: any[] = [];
  
  afterEach(() => {
    // Cleanup any stores created during tests
    stores.forEach(store => {
      if (store && typeof store.cleanup === 'function') {
        store.cleanup();
      }
    });
    stores.length = 0;
  });

  it('should create and initialize in-memory store', () => {
    const cfg = { ...loadSessionConfig(), kind: 'memory' as const };
    const store = createStore(cfg);
    stores.push(store);
    
    expect(store).toBeDefined();
    expect(typeof store.getMsgs).toBe('function');
    expect(typeof store.appendMsg).toBe('function');
    expect(typeof store.getSlots).toBe('function');
    expect(typeof store.setSlots).toBe('function');
  });

  it('should store and retrieve messages', async () => {
    const cfg = { ...loadSessionConfig(), kind: 'memory' as const };
    const store = createStore(cfg);
    stores.push(store);
    
    const testMsg = { role: 'user' as const, content: 'test message' };
    
    await store.appendMsg('test-id', testMsg);
    const messages = await store.getMsgs('test-id');
    
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(testMsg);
  });

  it('should store and retrieve slots', async () => {
    const cfg = { ...loadSessionConfig(), kind: 'memory' as const };
    const store = createStore(cfg);
    stores.push(store);
    
    await store.setSlots('test-id', { key1: 'value1', key2: 'value2' });
    const slots = await store.getSlots('test-id');
    
    expect(slots).toEqual({ key1: 'value1', key2: 'value2' });
  });

  it('should store and retrieve JSON data', async () => {
    const cfg = { ...loadSessionConfig(), kind: 'memory' as const };
    const store = createStore(cfg);
    stores.push(store);
    
    const testData = { nested: { value: 42 }, array: [1, 2, 3] };
    
    await store.setJson('test-key', 'test-id', testData);
    const retrieved = await store.getJson('test-key', 'test-id');
    
    expect(retrieved).toEqual(testData);
  });
});
