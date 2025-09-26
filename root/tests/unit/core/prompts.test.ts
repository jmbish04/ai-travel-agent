import { loadPrompt } from '../../../src/core/prompts.js';

describe('Prompts', () => {
  it('should load existing prompt', async () => {
    const prompt = await loadPrompt('system_prompt');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('should handle non-existent prompt', async () => {
    const prompt = await loadPrompt('non_existent_prompt');
    expect(prompt).toBe('');
  });

  it('should load router prompt', async () => {
    const prompt = await loadPrompt('router');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});
