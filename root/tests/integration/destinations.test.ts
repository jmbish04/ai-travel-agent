
import { runGraphTurn } from '../../src/core/graph';
import { getThreadSlots, updateThreadSlots } from '../../src/core/slot_memory';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('Destinations Integration Test', () => {
  it('should return a list of destinations when asked for recommendations', async () => {
    const threadId = 'test-thread';
    await updateThreadSlots(threadId, { region: 'Europe' }, []);

    const result = await runGraphTurn('recommend some destinations', threadId, { log: logger });

    expect(result.done).toBe(true);
    if (result.done) {
      expect(result.reply).toContain('Based on your preferences, here are some recommended destinations');
      expect(result.reply).toContain('France');
    }
  });
});
