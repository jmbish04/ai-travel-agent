/**
 * Integration test for flight clarification flow
 * Tests slot updates and follow-up resolution
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import { router } from '../../src/api/routes.js';
import { createLogger } from '../../src/util/logging.js';
import { chat } from '../helpers.js';

// Mock Amadeus responses
jest.mock('../../src/vendors/amadeus_client.js', () => ({
  AmadeusClient: jest.fn().mockImplementation(() => ({
    searchFlights: jest.fn().mockResolvedValue({
      data: [
        {
          id: '1',
          itineraries: [{
            segments: [{
              departure: { iataCode: 'JFK', at: '2024-09-20T10:00:00' },
              arrival: { iataCode: 'CDG', at: '2024-09-20T22:00:00' }
            }]
          }],
          price: { total: '450.00', currency: 'USD' }
        }
      ]
    })
  }))
}));

describe('Flight Clarification Flow', () => {
  let app: express.Express;

  beforeEach(() => {
    const log = createLogger();
    app = express();
    app.use(express.json());
    app.use('/', router(log));
  });

  test('should ask for clarification when origin missing', async () => {
    const response = await chat(app, 'flights to Paris tomorrow');
    
    // Should ask for origin
    expect(response.reply).toMatch(/where.*from|origin|departure/i);
    expect(response.threadId).toBeTruthy();
  });

  test('should complete search after clarification provided', async () => {
    // Initial incomplete request
    const firstResponse = await chat(app, 'flights to Paris tomorrow');
    expect(firstResponse.reply).toMatch(/where.*from|origin/i);
    
    // Provide missing information
    const secondResponse = await chat(app, 'from New York', firstResponse.threadId);
    
    // Should now have enough info to search
    expect(secondResponse.reply).toBeTruthy();
    expect(secondResponse.reply).toMatch(/flight|JFK|CDG|\$450/i);
  });

  test('should handle multi-step clarification', async () => {
    // Very incomplete request
    const firstResponse = await chat(app, 'I need flights');
    expect(firstResponse.reply).toMatch(/where.*to|destination/i);
    
    // Provide destination
    const secondResponse = await chat(app, 'to London', firstResponse.threadId);
    expect(secondResponse.reply).toMatch(/where.*from|origin/i);
    
    // Provide origin
    const thirdResponse = await chat(app, 'from Boston', secondResponse.threadId);
    expect(thirdResponse.reply).toMatch(/when|date/i);
    
    // Provide date
    const fourthResponse = await chat(app, 'next Friday', thirdResponse.threadId);
    
    // Should now complete search
    expect(fourthResponse.reply).toBeTruthy();
    expect(fourthResponse.reply).not.toMatch(/where|when|need/i);
  });
});
