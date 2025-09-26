import { getLimiter, scheduleWithLimit, getLimiterStats } from '../../../src/util/limiter.js';

describe('Limiter', () => {
  it('should get limiter for host', () => {
    const limiter = getLimiter('example.com');
    expect(limiter).toBeDefined();
    expect(typeof limiter.schedule).toBe('function');
  });

  it('should reuse limiter for same host', () => {
    const limiter1 = getLimiter('test.com');
    const limiter2 = getLimiter('test.com');
    expect(limiter1).toBe(limiter2);
  });

  it('should execute function with rate limiting', async () => {
    const testFn = jest.fn().mockResolvedValue('result');
    const result = await scheduleWithLimit('test-host.com', testFn);
    
    expect(result).toBe('result');
    expect(testFn).toHaveBeenCalledTimes(1);
  });

  it('should get limiter stats', () => {
    getLimiter('stats-test.com');
    const stats = getLimiterStats('stats-test.com');
    
    expect(stats).toBeDefined();
    expect(typeof stats?.queued).toBe('number');
    expect(stats?.running).toBeDefined(); // running() returns an object in Bottleneck
  });

  it('should return null for non-existent limiter stats', () => {
    const stats = getLimiterStats('non-existent.com');
    expect(stats).toBeNull();
  });
});
