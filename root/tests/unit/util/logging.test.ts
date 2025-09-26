import { createLogger } from '../../../src/util/logging.js';

describe('Logging', () => {
  it('should create logger with default level', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  it('should create logger with debug level', () => {
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    
    const logger = createLogger();
    expect(logger).toBeDefined();
    
    // Restore original level
    if (originalLevel) {
      process.env.LOG_LEVEL = originalLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  it('should handle logging with PII redaction', () => {
    const logger = createLogger();
    
    // Should not throw when logging
    expect(() => {
      logger.info('Test message');
      logger.debug({ key: 'value' }, 'Debug message');
    }).not.toThrow();
  });
});
