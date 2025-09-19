/**
 * Integration test for policy browser confidence-based fallback
 * Tests low-confidence policy extraction triggering fallback
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { PolicyAgent } from '../../src/core/policy_agent.js';
import { createLogger } from '../../src/util/logging.js';

// Mock policy extraction with low confidence
jest.mock('../../src/core/policy_browser.js', () => ({
  extractPolicyClause: jest.fn().mockResolvedValue({
    confidence: 0.5, // Below 0.6 threshold
    text: 'Unclear policy text...',
    source: 'policy-page'
  })
}));

describe('Policy Browser Confidence', () => {
  const logger = createLogger();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should trigger fallback when confidence below threshold', async () => {
    const agent = new PolicyAgent(logger);
    
    const result = await agent.answer('What is the baggage policy?');
    
    // Should indicate uncertainty due to low confidence
    expect(result.answer).toMatch(/unclear|uncertain|check|contact/i);
    expect(result.confidence).toBeLessThan(0.6);
  });

  test('should use high-confidence extractions', async () => {
    // Mock high confidence extraction
    const { extractPolicyClause } = await import('../../src/core/policy_browser.js');
    jest.mocked(extractPolicyClause).mockResolvedValueOnce({
      confidence: 0.9,
      text: 'Baggage allowance is 23kg for economy class.',
      source: 'baggage-policy'
    });

    const agent = new PolicyAgent(logger);
    const result = await agent.answer('What is the baggage policy?');
    
    // Should use the high-confidence extraction
    expect(result.answer).toContain('23kg');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('should log confidence scores for routing decisions', async () => {
    const logSpy = jest.spyOn(logger, 'debug');
    
    const agent = new PolicyAgent(logger);
    await agent.answer('What is the baggage policy?');
    
    // Should log confidence-based routing decision
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence: expect.any(Number),
        routing_decision: expect.any(String)
      }),
      expect.stringContaining('policy_confidence')
    );
  });
});
