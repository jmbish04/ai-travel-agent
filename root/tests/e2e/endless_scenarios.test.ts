import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { handleChat } from '../../src/core/blend.js';
import { createLogger } from '../../src/util/logging.js';
import nock from 'nock';

// Configure nock
nock.disableNetConnect();
nock.enableNetConnect((host) => {
  if (host.includes('127.0.0.1') || host.includes('localhost')) return true;
  if (host.includes('openrouter.ai')) return true;
  if (host.includes('api.open-meteo.com')) return true;
  if (host.includes('geocoding-api.open-meteo.com')) return true;
  if (host.includes('restcountries.com')) return true;
  if (host.includes('api.opentripmap.com')) return true;
  if (host.includes('api.search.brave.com')) return true;
  return false;
});

// Helper to send metrics to server
async function sendMetric(name: string, labels: Record<string, string> = {}, value: number = 1) {
  try {
    await fetch('http://localhost:3001/metrics/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, labels, value })
    });
  } catch (error) {
    console.warn('Failed to send metric:', error);
  }
}

describe('Endless Scenarios with Live Metrics', () => {
  const log = createLogger();

  afterEach(() => {
    nock.cleanAll();
  });

  const scenarios = [
    {
      name: 'Weather Paris',
      query: 'Weather in Paris today?',
      intent: 'weather',
      expectedSources: ['weather']
    },
    {
      name: 'Destinations June',
      query: 'Where to travel in June from NYC? Prefer not too hot.',
      intent: 'destinations', 
      expectedSources: ['weather', 'country']
    },
    {
      name: 'Packing Tokyo',
      query: 'What to pack for Tokyo in March?',
      intent: 'packing',
      expectedSources: ['weather']
    },
    {
      name: 'Attractions Lisbon',
      query: 'What to see in Lisbon for a day?',
      intent: 'attractions',
      expectedSources: ['attractions']
    },
    {
      name: 'Weather Madrid',
      query: 'Weather in Madrid this week',
      intent: 'weather',
      expectedSources: ['weather']
    }
  ];

  // Run each scenario
  scenarios.forEach((scenario, index) => {
    it(`should handle ${scenario.name} (${index + 1}/${scenarios.length})`, async () => {
      const startTime = Date.now();
      const threadId = `endless-${scenario.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
      
      try {
        const result = await handleChat({ 
          message: scenario.query, 
          threadId 
        }, { log });
        
        const duration = Date.now() - startTime;
        
        // Basic validations
        expect(result).toBeDefined();
        expect(result.reply).toBeDefined();
        expect(result.reply.length).toBeGreaterThan(10);
        
        // Track metrics via HTTP
        await sendMetric('messages_total', { intent: scenario.intent, stage: 'route' });
        await sendMetric('stage_latency_ms', { stage: 'route', intent: scenario.intent }, duration);
        
        // Verify response quality (simplified)
        const hasValidResponse = result.reply.length > 50 && !result.reply.includes('error');
        await sendMetric('stage_verify_success', { stage: 'verify', intent: scenario.intent }, hasValidResponse ? 1 : 0);
        
        log.info(`✅ ${scenario.name}: ${duration}ms, ${result.reply.length} chars`);
        
      } catch (error) {
        // Track failure
        await sendMetric('stage_verify_success', { stage: 'verify', intent: scenario.intent }, 0);
        
        console.error(`❌ ${scenario.name} failed:`, error);
        throw error;
      }
    }, 30000);
  });

  // Random scenario selector for variety
  it('should handle random scenario', async () => {
    const randomScenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    const threadId = `random-${Date.now()}`;
    
    const result = await handleChat({ 
      message: randomScenario.query, 
      threadId 
    }, { log });
    
    expect(result).toBeDefined();
    expect(result.reply).toBeDefined();
    
    log.info(`🎲 Random: ${randomScenario.name}`);
  }, 30000);
});
