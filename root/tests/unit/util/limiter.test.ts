import { createLimiter } from '../../../src/util/limiter.js';

describe('Limiter', () => {
  it('should create limiter with default config', () => {
    const limiter = createLimiter();
    expect(limiter).toBeDefined();
    expect(typeof limiter.schedule).toBe('function');
  });

  it('should create limiter with custom config', () => {
    const limiter = createLimiter({ maxConcurrent: 2, minTime: 100 });
    expect(limiter).toBeDefined();
  });

  it('should execute function through limiter', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, minTime: 10 });
    
    const testFn = jest.fn().mockResolvedValue('result');
    const result = await limiter.schedule(() => testFn());
    
    expect(result).toBe('result');
    expect(testFn).toHaveBeenCalledTimes(1);
  });
});
