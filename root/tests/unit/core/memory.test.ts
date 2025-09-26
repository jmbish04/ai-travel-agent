import { pushMessage, getMessages } from '../../../src/core/memory.js';
import { createStore, initSessionStore } from '../../../src/core/session_store.js';
import { loadSessionConfig } from '../../../src/config/session.js';

describe('Memory', () => {
  beforeAll(() => {
    const cfg = loadSessionConfig();
    const store = createStore(cfg);
    initSessionStore(store);
  });

  it('should push and retrieve messages', async () => {
    const threadId = 'test-thread-1';
    
    await pushMessage(threadId, { role: 'user', content: 'Hello' });
    await pushMessage(threadId, { role: 'assistant', content: 'Hi there!' });
    
    const messages = await getMessages(threadId);
    
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
  });

  it('should handle empty thread', async () => {
    const messages = await getMessages('empty-thread');
    expect(messages).toHaveLength(0);
  });
});
