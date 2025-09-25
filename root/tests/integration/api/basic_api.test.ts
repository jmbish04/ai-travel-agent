import request from 'supertest';
import { makeTestApp, setupHttpMocks, teardownHttpMocks } from '../../helpers/http.js';

describe('API basic endpoints', () => {
  beforeAll(() => setupHttpMocks());
  afterAll(() => teardownHttpMocks());

  it('healthz responds ok', async () => {
    // Prevent loading real ESM deps by stubbing search
    jest.doMock('../../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: 'stub', source: 'stub', results: [] }),
      getSearchCitation: () => 'stub',
      getSearchSource: () => 'stub',
    }));
    const app = await makeTestApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('chat returns reply and threadId; /why path surfaces receipts', async () => {
    jest.doMock('../../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: 'stub', source: 'stub', results: [] }),
      getSearchCitation: () => 'stub',
      getSearchSource: () => 'stub',
    }));
    const app = await makeTestApp();
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
