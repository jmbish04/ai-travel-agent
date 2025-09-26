import { assessQueryComplexity } from '../../../src/core/complexity.js';

// Mock the LLM module before importing
jest.mock('../../../src/core/llm', () => ({
  callLLM: jest.fn()
}));

describe('Complexity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should assess complexity for simple message', async () => {
    const { callLLM } = await import('../../../src/core/llm.js');
    (callLLM as jest.Mock).mockResolvedValue('{"isComplex": false, "confidence": 0.8, "reasoning": "Simple greeting"}');

    const assessment = await assessQueryComplexity('Hello world');
    expect(assessment).toBeDefined();
    expect(typeof assessment.isComplex).toBe('boolean');
    expect(typeof assessment.confidence).toBe('number');
    expect(typeof assessment.reasoning).toBe('string');
  });

  it('should handle LLM errors gracefully', async () => {
    const { callLLM } = await import('../../../src/core/llm.js');
    (callLLM as jest.Mock).mockRejectedValue(new Error('LLM error'));

    const assessment = await assessQueryComplexity('Test message');
    expect(assessment.isComplex).toBe(false);
    expect(assessment.confidence).toBe(0);
    expect(assessment.reasoning).toBe('llm_error');
  });
});
