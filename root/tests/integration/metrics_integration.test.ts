import { describe, it, expect, beforeEach } from '@jest/globals';
import { handleChat } from '../../src/core/blend.js';
import { snapshot } from '../../src/util/metrics.js';
import { createLogger } from '../../src/util/logging.js';
import '../setup/jest.setup.js'; // Import setup to initialize session store

describe('Metrics Integration', () => {
  const log = createLogger();

  beforeEach(() => {
    // Reset metrics
    snapshot();
  });

  it('should track metrics during a conversation flow', async () => {
    // Test a simple weather query that should trigger metrics
    const result = await handleChat({
      message: 'What is the weather in Paris?',
      threadId: 'test-metrics-thread'
    }, { log });

    expect(result.reply).toBeDefined();
    
    const metrics = snapshot();
    
    // Should have at least one chat turn
    expect(Object.keys(metrics.chat_turns).length).toBeGreaterThan(0);
    
    // Should track the weather intent
    expect(metrics.chat_turns.weather).toBe(1);
  });

  it('should track clarification requests', async () => {
    // Test a query that should require clarification
    const result = await handleChat({
      message: 'What should I pack?',
      threadId: 'test-clarify-thread'
    }, { log });

    expect(result.reply).toBeDefined();
    
    const metrics = snapshot();
    
    // Should have clarification requests for missing slots
    expect(Object.keys(metrics.clarify_requests).length).toBeGreaterThan(0);
  });
});
