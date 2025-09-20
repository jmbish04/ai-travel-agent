/**
 * Integration test for consent flow routing
 * Tests deep research consent prompting and execution
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import { router } from '../../src/api/routes.js';
import { createLogger } from '../../src/util/logging.js';
import { chat, mockExternalApis } from '../helpers.js';

describe('Router Consent Flow', () => {
  let app: express.Express;

  beforeEach(() => {
    // Enable deep research for consent testing
    process.env.DEEP_RESEARCH_ENABLED = 'true';
    
    const log = createLogger();
    app = express();
    app.use(express.json());
    app.use('/', router(log));
  });

  test('should prompt for consent when deep research enabled', async () => {
    await mockExternalApis({ searchFixture: 'hotels_paris' });
    
    const response = await chat(app, 'find me luxury hotels in Paris');
    
    // Should ask for consent first
    expect(response.reply).toMatch(/search|look up|web/i);
    expect(response.reply).toMatch(/want|would you like|shall I/i);
    expect(response.threadId).toBeTruthy();
  });

  test('should execute search after consent given', async () => {
    await mockExternalApis({ searchFixture: 'hotels_paris' });
    
    // First request - should ask for consent
    const firstResponse = await chat(app, 'find me luxury hotels in Paris');
    expect(firstResponse.reply).toMatch(/search|look up/i);
    
    // Second request - give consent
    const secondResponse = await chat(app, 'yes', firstResponse.threadId);
    
    // Should now execute search and provide results
    expect(secondResponse.reply).toBeTruthy();
    expect(secondResponse.reply).not.toMatch(/search|look up/i);
    expect(secondResponse.citations).toBeDefined();
  });

  test('should handle consent denial gracefully', async () => {
    const firstResponse = await chat(app, 'find me luxury hotels in Paris');
    expect(firstResponse.reply).toMatch(/search|look up/i);
    
    // Deny consent
    const secondResponse = await chat(app, 'no', firstResponse.threadId);
    
    // Should acknowledge and not search
    expect(secondResponse.reply).toMatch(/understand|okay|without/i);
    expect(secondResponse.citations).toBeUndefined();
  });
});
