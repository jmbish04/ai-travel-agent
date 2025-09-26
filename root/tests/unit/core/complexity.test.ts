import { calculateComplexity } from '../../../src/core/complexity.js';

describe('Complexity', () => {
  it('should calculate complexity for simple message', () => {
    const complexity = calculateComplexity('Hello world');
    expect(complexity).toBeGreaterThan(0);
    expect(complexity).toBeLessThan(1);
  });

  it('should calculate higher complexity for complex message', () => {
    const simpleComplexity = calculateComplexity('Hi');
    const complexComplexity = calculateComplexity('I need to book a flight from New York to London with specific dates and preferences for hotels and restaurants');
    
    expect(complexComplexity).toBeGreaterThan(simpleComplexity);
  });

  it('should handle empty message', () => {
    const complexity = calculateComplexity('');
    expect(complexity).toBe(0);
  });

  it('should handle very long message', () => {
    const longMessage = 'word '.repeat(1000);
    const complexity = calculateComplexity(longMessage);
    expect(complexity).toBeGreaterThan(0);
  });
});
