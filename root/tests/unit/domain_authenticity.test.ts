import { describe, test, expect } from '@jest/globals';
import { scoreDomainAuthenticity } from '../../src/core/domain_authenticity.js';

describe('Domain Authenticity Classification (LLM Only)', () => {
  test('official airline sites get high confidence', async () => {
    const officialSites = [
      { domain: 'lufthansa.com', airline: 'Lufthansa' },
      { domain: 'delta.com', airline: 'Delta' },
      { domain: 'elal.com', airline: 'El Al' }
    ];
    
    for (const site of officialSites) {
      const result = await scoreDomainAuthenticity(site.domain, site.airline);
      expect(result.confidence).toBeGreaterThan(0.7); // LLM should score official sites high
      expect(result.reasoning).toBe('llm_classified');
    }
  });
  
  test('third-party agents get low confidence', async () => {
    const agentSites = [
      { domain: 'expedia.com', airline: 'Delta' },
      { domain: 'upgradedpoints.com', airline: 'El Al' },
      { domain: 'booking.com', airline: 'Lufthansa' }
    ];
    
    for (const site of agentSites) {
      const result = await scoreDomainAuthenticity(site.domain, site.airline);
      expect(result.confidence).toBeLessThan(0.6); // LLM should score agents low
      expect(result.reasoning).toBe('llm_classified');
    }
  });
  
  test('handles timeout gracefully', async () => {
    const signal = AbortSignal.timeout(1);
    const result = await scoreDomainAuthenticity('test.com', 'TestAirline', signal);
    
    expect(result.domain).toBe('test.com');
    expect(result.reasoning).toBe('llm_classified');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
