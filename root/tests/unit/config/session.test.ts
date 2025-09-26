import { loadSessionConfig } from '../../../src/config/session.js';

describe('Session Config', () => {
  it('should load default session config', () => {
    const config = loadSessionConfig();
    
    expect(config).toBeDefined();
    expect(config.kind).toBeDefined();
    expect(config.ttlSec).toBeGreaterThan(0);
  });

  it('should use in-memory store by default', () => {
    const config = loadSessionConfig();
    expect(config.kind).toBe('inmemory');
  });

  it('should handle redis config when REDIS_URL is set', () => {
    const originalRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://localhost:6379';
    
    const config = loadSessionConfig();
    expect(config.kind).toBe('redis');
    
    // Restore original value
    if (originalRedisUrl) {
      process.env.REDIS_URL = originalRedisUrl;
    } else {
      delete process.env.REDIS_URL;
    }
  });
});
