import { loadSessionConfig } from '../../../src/config/session.js';

describe('Session Config', () => {
  const originalStore = process.env.SESSION_STORE;

  afterEach(() => {
    if (originalStore) {
      process.env.SESSION_STORE = originalStore;
    } else {
      delete process.env.SESSION_STORE;
    }
  });

  it('should load default session config', () => {
    const config = loadSessionConfig();

    expect(config).toBeDefined();
    expect(config.kind).toBeDefined();
    expect(config.ttlSec).toBeGreaterThan(0);
  });

  it('should default to cloudflare storage when no override is provided', () => {
    delete process.env.SESSION_STORE;
    const config = loadSessionConfig();
    expect(config.kind).toBe('cloudflare');
  });

  it('should handle explicit memory config', () => {
    process.env.SESSION_STORE = 'memory';

    const config = loadSessionConfig();
    expect(config.kind).toBe('memory');
  });
});
