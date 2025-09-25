import request from 'supertest';
import { makeTestApp, setupHttpMocks, teardownHttpMocks } from '../../helpers/http.js';

describe('API basic endpoints', () => {
  beforeAll(() => setupHttpMocks());
  afterAll(() => teardownHttpMocks());

  it('metrics endpoint responds in JSON mode', async () => {
    jest.doMock('../../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: 'stub', source: 'stub', results: [] }),
      getSearchCitation: () => 'stub',
      getSearchSource: () => 'stub',
    }));
    jest.doMock('../../../src/tools/packing', () => ({
      suggestPacking: async () => ({ ok: true, summary: 'stub packing', source: 'stub', band: 'mild', items: { base: [], special: {} } })
    }));
    const app = await makeTestApp();
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    // JSON mode by default
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toBeDefined();
  });

  it('chat returns reply and threadId; /why path surfaces receipts', async () => {
    jest.doMock('../../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: 'stub', source: 'stub', results: [] }),
      getSearchCitation: () => 'stub',
      getSearchSource: () => 'stub',
    }));
    jest.doMock('../../../src/tools/packing', () => ({
      suggestPacking: async () => ({ ok: true, summary: 'stub packing', source: 'stub', band: 'mild', items: { base: [], special: {} } })
    }));
    let app;
    try {
      app = await makeTestApp();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('makeTestApp failed:', err);
      throw err;
    }
    // Normal chat
    const res1 = await request(app)
      .post('/chat')
      .send({ message: 'Hello there' });
    expect(res1.status).toBe(200);
    expect(typeof res1.body.reply).toBe('string');
    expect(typeof res1.body.threadId).toBe('string');

    // /why triggers receipts scaffold (auto verify may be off)
    const res2 = await request(app)
      .post('/chat')
      .send({ message: '/why', threadId: res1.body.threadId });
    expect(res2.status).toBe(200);
    expect(typeof res2.body.reply).toBe('string');
    // Receipts are optional, but when present must have sources and budgets
    if (res2.body.receipts) {
      expect(Array.isArray(res2.body.receipts.sources)).toBe(true);
      expect(res2.body.receipts.budgets).toBeDefined();
    }
  });
});
