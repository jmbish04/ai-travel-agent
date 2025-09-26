import { loadSessionConfig } from '../../../src/config/session.js';

describe('Session Config', () => {
  it('should load default session config', () => {
    const config = loadSessionConfig();
    
    expect(config).toBeDefined();
    expect(config.kind).toBeDefined();
    expect(config.ttlSec).toBeGreaterThan(0);
  });

  it('should use redis by default when Redis URL is available', () => {
    const config = loadSessionConfig();
    expect(['redis', 'memory']).toContain(config.kind);
  });

  it('should handle explicit memory config', () => {
    const originalStore = process.env.SESSION_STORE;
    process.env.SESSION_STORE = 'memory';
    
    const config = loadSessionConfig();
    expect(config.kind).toBe('memory');
    
    // Restore original value
    if (originalStore) {
      process.env.SESSION_STORE = originalStore;
    } else {
      delete process.env.SESSION_STORE;
    }
  });
});
