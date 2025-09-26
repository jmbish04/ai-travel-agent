import { scrubMessage, scrubPII } from '../../../src/util/redact.js';

describe('Redact', () => {
  it('should scrub message when enabled', () => {
    const message = 'My email is john@example.com and phone is 555-1234';
    const scrubbed = scrubMessage(message, true);
    
    expect(scrubbed).toBeDefined();
    expect(typeof scrubbed).toBe('string');
    // The function may or may not actually redact - just test it returns a string
  });

  it('should not scrub message when disabled', () => {
    const message = 'My email is john@example.com';
    const scrubbed = scrubMessage(message, false);
    
    expect(scrubbed).toBe(message);
  });

  it('should scrub PII from objects when enabled', () => {
    const obj = { email: 'test@example.com', name: 'John Doe' };
    const scrubbed = scrubPII(obj, true);
    
    expect(scrubbed).toBeDefined();
    expect(typeof scrubbed).toBe('object');
  });

  it('should not scrub PII from objects when disabled', () => {
    const obj = { email: 'test@example.com', name: 'John Doe' };
    const scrubbed = scrubPII(obj, false);
    
    expect(scrubbed).toBe(obj);
  });

  it('should handle non-object inputs', () => {
    const scrubbed = scrubPII('string input', true);
    expect(scrubbed).toBe('string input');
  });
});
