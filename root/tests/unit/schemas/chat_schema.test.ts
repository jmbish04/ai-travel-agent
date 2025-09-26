import { ChatInput, ChatOutput } from '../../../src/schemas/chat.js';

describe('Chat schemas', () => {
  it('validates ChatInput shape', () => {
    const ok = ChatInput.safeParse({ message: 'hi', threadId: 't-123', receipts: true });
    expect(ok.success).toBe(true);
  });

  it('rejects empty message', () => {
    const bad = ChatInput.safeParse({ message: '' });
    expect(bad.success).toBe(false);
  });

  it('validates ChatOutput with receipts', () => {
    const reply = {
      reply: 'Hello',
      threadId: 't-1',
      sources: ['example'],
      receipts: {
        sources: ['example'],
        decisions: ['unit_test'],
        selfCheck: { verdict: 'warn', notes: ['noop'] },
        budgets: { token_estimate: 100 }
      }
    };
    const ok = ChatOutput.safeParse(reply);
    expect(ok.success).toBe(true);
  });
});

