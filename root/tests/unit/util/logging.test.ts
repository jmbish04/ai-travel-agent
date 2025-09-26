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

  it('should create logger with custom level', () => {
    const logger = createLogger('debug');
    expect(logger).toBeDefined();
  });

  it('should handle invalid log level', () => {
    const logger = createLogger('invalid' as any);
    expect(logger).toBeDefined();
  });
});
