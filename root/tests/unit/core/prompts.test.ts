import { getPrompt } from '../../../src/core/prompts.js';

describe('Prompts', () => {
  it('should load existing prompt', async () => {
    const prompt = await getPrompt('meta_agent');
    expect(typeof prompt).toBe('string');
  });

  it('should handle non-existent prompt', async () => {
    const prompt = await getPrompt('planner');
    expect(typeof prompt).toBe('string');
  });

  it('should load verify prompt', async () => {
    const prompt = await getPrompt('verify');
    expect(typeof prompt).toBe('string');
  });
});
