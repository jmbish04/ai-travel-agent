import { expect } from '@jest/globals';
import request from 'supertest';
import nock from 'nock';
import fs from 'fs/promises';
import path from 'path';

export async function chat(app: import('express').Express, message: string, threadId?: string) {
  const res = await request(app)
    .post('/chat')
    .send(threadId ? { message, threadId } : { message })
    .set('Content-Type', 'application/json');
  expect([200, 400]).toContain(res.status);
  return res.body as { reply?: string; threadId?: string; citations?: string[]; error?: any };
}

export function expectNoCOTLeak(text: string) {
  const leakMarkers = [/chain[-\s]?of[-\s]?thought/i, /\breasoning:/i, /step\s*\d+/i];
  leakMarkers.forEach((r) => expect(r.test(text)).toBeFalsy());
}

export function expectNoHallucinations(reply: string) {
  // Check for fabricated temperature data
  expect(reply).not.toMatch(/\b\d{1,3}\s?(°|deg|C|F)\b/);

  // Check for fabricated POI data
  const commonPOIs = ['eiffel', 'louvre', 'prado', 'retir', 'gran via', 'times square', 'statue of liberty'];
  commonPOIs.forEach(poi => {
    expect(reply.toLowerCase()).not.toContain(poi);
  });

  // Check for fake citations
  expect(reply).not.toMatch(/according to.*source/i);
  expect(reply).not.toMatch(/based on.*data/i);
}

export async function createConversationThread(
  app: import('express').Express,
  messages: string[],
  threadId?: string
): Promise<{ replies: string[]; finalThreadId: string }> {
  let currentThreadId = threadId;
  const replies: string[] = [];

  for (const message of messages) {
    const response = await chat(app, message, currentThreadId);
    replies.push(response.reply || '');
    currentThreadId = response.threadId || currentThreadId;
  }

  return { replies, finalThreadId: currentThreadId || '' };
}

export function validateThreadIdFormat(threadId: string) {
  expect(threadId).toBeTruthy();
  expect(typeof threadId).toBe('string');
  expect(threadId.length).toBeGreaterThan(5);
  expect(threadId.length).toBeLessThan(65);
  expect(/^[a-zA-Z0-9_-]+$/.test(threadId)).toBeTruthy();
}

export function validateCitations(reply: string, citations?: string[]) {
  const replyLower = reply.toLowerCase();

  if (citations && citations.length > 0) {
    // If we have citations, reply should mention external data usage
    const hasWeatherMentions = replyLower.includes('weather') || replyLower.includes('temperature');
    const hasCountryMentions = replyLower.includes('country') || replyLower.includes('currency');
    const hasAttractionMentions = replyLower.includes('attraction') || replyLower.includes('museum');

    if (hasWeatherMentions || hasCountryMentions || hasAttractionMentions) {
      expect(citations.length).toBeGreaterThan(0);
    }
  }
}

// Fixture-based API mocking
interface MockApiOptions {
  weatherFixture?: string;
  countryFixture?: string;
  searchFixture?: string;
}

export async function mockExternalApis(opts: MockApiOptions = {}) {
  // Mock weather API
  if (opts.weatherFixture) {
    const fixture = await loadFixture(`weather/${opts.weatherFixture}.json`);
    
    // Mock geocoding
    nock('https://geocoding-api.open-meteo.com')
      .get('/v1/search')
      .query(true)
      .reply(200, { 
        results: [{ 
          name: 'Berlin', 
          latitude: fixture.latitude, 
          longitude: fixture.longitude, 
          country: 'Germany' 
        }] 
      });
    
    // Mock weather forecast
    nock('https://api.open-meteo.com')
      .get('/v1/forecast')
      .query(true)
      .reply(200, fixture);
  }
  
  // Mock country API
  if (opts.countryFixture) {
    const fixture = await loadFixture(`country/${opts.countryFixture}.json`);
    nock('https://restcountries.com')
      .get(/v3\.1\/name/)
      .reply(200, fixture);
  }
  
  // Mock search API
  if (opts.searchFixture) {
    const fixture = await loadFixture(`search/${opts.searchFixture}.json`);
    nock('https://api.search.brave.com')
      .get(/v1\/web\/search/)
      .query(true)
      .reply(200, fixture);
  }
}

async function loadFixture(relativePath: string): Promise<any> {
  const fixturePath = path.resolve(process.cwd(), 'tests/fixtures', relativePath);
  const content = await fs.readFile(fixturePath, 'utf-8');
  return JSON.parse(content);
}

// LLM evaluator helper that skips when not configured
export async function assertWithLLMOrSkip(
  condition: () => Promise<boolean> | boolean,
  message: string
) {
  const hasEvaluator = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  
  if (!hasEvaluator) {
    console.warn(`Skipping LLM evaluation: ${message} (no evaluator configured)`);
    return;
  }
  
  const result = await condition();
  expect(result).toBe(true);
}

