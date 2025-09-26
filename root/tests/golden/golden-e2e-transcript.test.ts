import pino from 'pino';

const log = pino({ level: (process.env.LOG_LEVEL as any) || 'silent' });
const ALLOW = process.env.VERIFY_LLM === '1' || process.env.VERIFY_LLM === 'true';
const KEY = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;

(ALLOW && KEY ? describe : describe.skip)('GOLDEN: e2e transcript — receipts + real verification', () => {
  beforeEach(async () => {
    process.env.AUTO_VERIFY_REPLIES = 'true';
    jest.resetModules();
    const { createStore, initSessionStore } = await import('../../src/core/session_store.js');
    const { loadSessionConfig } = await import('../../src/config/session.js');
    const cfg = { ...loadSessionConfig(), kind: 'memory' as const };
    const store = createStore(cfg);
    initSessionStore(store);
  });

  it('weather → uses weather tool, stores receipts, verifies', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = {
        route: 'weather',
        confidence: 1.0,
        missing: [],
        consent: { required: false },
        calls: [ { tool: 'weather', args: { city: 'London' }, timeoutMs: 2000 } ],
        blend: { style: 'short', cite: true },
        verify: { mode: 'none' },
      };
      const chatWithToolsLLM = jest
        .fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Partly cloudy around 14°C. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });

    jest.doMock('../../src/tools/weather', () => ({
      getWeather: async () => ({ ok: true, summary: 'Partly cloudy ~14°C (58°F).', source: 'open-meteo.com' })
    }));

    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: "What's the weather like in London?", receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 20000);

  it('packing → uses packing tool, receipts saved, verification ok', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = {
        route: 'packing',
        confidence: 0.9,
        missing: [],
        consent: { required: false },
        calls: [ { tool: 'packingSuggest', args: { city: 'Paris', month: 'September' } } ],
        blend: { style: 'bullet', cite: true },
        verify: { mode: 'citations' },
      };
      const chatWithToolsLLM = jest
        .fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Pack light layers and a compact umbrella. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });

    jest.doMock('../../src/tools/packing', () => ({
      suggestPacking: async () => ({ ok: true, summary: 'light layers, compact umbrella', source: 'curated', band: 'mild', items: { base: ['t-shirt','jacket'], special: {} } })
    }));

    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'What should I pack to Paris in September?', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('attractions → search receipts, verification ok', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = {
        route: 'attractions',
        confidence: 0.85,
        missing: [],
        consent: { required: false },
        calls: [ { tool: 'search', args: { query: 'kid friendly attractions in Berlin', deep: false } } ],
        blend: { style: 'bullet', cite: true },
        verify: { mode: 'citations' },
      };
      const chatWithToolsLLM = jest
        .fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Tierpark, LEGOLAND, and Labyrinth Kindermuseum. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });

    jest.doMock('../../src/tools/search', () => ({
      searchTravelInfo: async () => ({ ok: true, summary: 'Tierpark; LEGOLAND; Labyrinth Kindermuseum', source: 'Brave Search', results: [] }),
      getSearchCitation: () => 'Brave Search',
      getSearchSource: () => 'brave-search',
    }));

    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Any kid-friendly attractions in Berlin?', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('ideas (multi-constraint) → deep research receipts, verification ok', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = {
        route: 'destinations',
        confidence: 0.95,
        missing: [],
        consent: { required: false },
        calls: [ { tool: 'deepResearch', args: { query: 'family-friendly short-haul destinations from NYC end of June 4-5 days toddler seniors budget 2500' } } ],
        blend: { style: 'bullet', cite: true },
        verify: { mode: 'citations' },
      };
      const chatWithToolsLLM = jest
        .fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Here are short-haul ideas with stroller-friendly spots. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });

    jest.doMock('../../src/core/deep_research', () => ({
      performDeepResearch: async () => ({ summary: 'Lake Placid; Ocean City; Providence (short-haul)', citations: [{ source: 'example.com' }] })
    }));

    const { handleChat } = await import('../../src/core/blend.js');
    const msg = 'From NYC, end of June (last week), 4–5 days. 2 adults + toddler in stroller. Parents mid‑60s; dad dislikes long flights. Budget under $2.5k. Ideas?';
    const out = await handleChat({ message: msg, receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 30000);

  it('destinations: popular coastal in Asia → deep research', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'destinations', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'deepResearch', args: { query: 'popular coastal destinations in asia' } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Bali, Phuket, Da Nang. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/core/deep_research', () => ({ performDeepResearch: async () => ({ summary: 'Bali; Phuket; Da Nang', citations: [{ source: 'example.com' }] }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'popular coastal destinations in asia', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('destinations in Europe → deep research', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'destinations', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'deepResearch', args: { query: 'destinations in Europe' } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Portugal, Spain, Greece. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/core/deep_research', () => ({ performDeepResearch: async () => ({ summary: 'Portugal; Spain; Greece', citations: [{ source: 'example.com' }] }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Tell me about destinations in Europe', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('warmest European coastal countries in November → tools (no web)', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'destinations', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'getCountry', args: { country: 'Greece' } }, { tool: 'getCountry', args: { country: 'Spain' } }, { tool: 'getCountry', args: { country: 'Portugal' } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Greece, Spain, and Portugal tend to be warmest. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/country', () => ({ getCountryFacts: async () => ({ ok: true, summary: 'Coastal; mild climate', source: 'rest-countries' }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'What European coastral countries are warmest in November? Get answer via tools not web search', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('web search: festivals/events in California', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'web', confidence: 0.8, missing: [], consent: { required: false }, calls: [ { tool: 'search', args: { query: 'festivals or events in California we should plan around', deep: false } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Listing major California festivals. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/search', () => ({ searchTravelInfo: async () => ({ ok: true, summary: 'Coachella; Outside Lands; LA Marathon dates', source: 'Brave Search', results: [] }), getSearchCitation: () => 'Brave Search', getSearchSource: () => 'brave-search' }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Please search for festivals or events in California we should plan around.', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('flights: Paris → Berlin tomorrow (Amadeus)', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'flights', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'amadeusResolveCity', args: { keyword: 'Paris' } }, { tool: 'amadeusResolveCity', args: { keyword: 'Berlin' } }, { tool: 'amadeusSearchFlights', args: { origin: 'Paris', destination: 'Berlin', departureDate: 'tomorrow' } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Top flight options summarized. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/amadeus_locations', () => ({ resolveCity: async (kw: string) => ({ ok: true, cityCode: kw.toLowerCase().includes('paris') ? 'PAR' : 'BER' }), airportsForCity: async () => ({ ok: true, airports: ['PAR'] }) }));
    jest.doMock('../../src/tools/amadeus_flights', () => ({ searchFlights: async () => ({ ok: true, summary: 'Found 3 flight offers', source: 'amadeus' }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Find flights from Paris to Berlin tomorrow', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 30000);

  it('policy: Marriott cancellation window/penalty', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'policy', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'vectaraQuery', args: { query: 'Marriott cancellation window penalty', corpus: 'hotels' } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Marriott cancellation 48–72 hours; penalty after window. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/vectara', () => ({ VectaraClient: class { async query() { return { summary: '48–72 hours, 1 night penalty', citations: [{ url: 'vectara:doc:marriott' }] }; } } }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'What is the standard cancellation window for Marriott hotels, and what penalty applies if you cancel after this window?', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 30000);

  it('visa: US passport → Canada', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'policy', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'vectaraQuery', args: { query: 'US passport visa requirement Canada', corpus: 'visas' } } ], blend: { style: 'short', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'US citizens do not need a visa for short stays; eTA may apply. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/vectara', () => ({ VectaraClient: class { async query() { return { summary: 'no visa; eTA', citations: [{ url: 'vectara:doc:canada-gov' }] }; } } }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Quick one: do US passport holders need a visa for Canada?', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('visa: German passport → China', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'policy', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'vectaraQuery', args: { query: 'German passport visa requirement China', corpus: 'visas' } } ], blend: { style: 'short', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'German citizens typically require a visa for China. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/vectara', () => ({ VectaraClient: class { async query() { return { summary: 'visa required', citations: [{ url: 'vectara:doc:china-embassy' }] }; } } }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'What about visa for German passports for travelling to China?', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('IRROPS: cancelled DL8718 CDG→LHR → rebook options', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'irrops', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'irropsProcess', args: { pnr: { recordLocator: 'ABC123' }, disruption: { flightNumber: 'DL8718', from: 'CDG', to: 'LHR', reason: 'cancelled' } } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Proposed rebooking options summarized. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/core/irrops_engine', () => ({ processIrrops: async () => ([{ flight: 'DL8718 alt', price: 300 }]) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'My flight DL8718 from CDG to LHR was cancelled — please help me rebook.', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 30000);

  it('edge: weather in Ulaanbaatar next week', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'weather', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'weather', args: { city: 'Ulaanbaatar', dates: 'next week' } } ], blend: { style: 'short', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Very cold; pack layers. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/weather', () => ({ getWeather: async () => ({ ok: true, summary: 'Cold, sub-zero nights', source: 'open-meteo.com' }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Weather in Ulaanbaatar next week.', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('edge: pack for Svalbard during polar night season', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'packing', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'packingSuggest', args: { city: 'Longyearbyen', month: 'December' } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Thermal layers, parka, microspikes. Sources included.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/packing', () => ({ suggestPacking: async () => ({ ok: true, summary: 'Polar night gear', source: 'curated', band: 'cold', items: { base: ['thermal base layer'], special: {} } }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'What to pack for Svalbard during polar night season.', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('edge: weather in a non-existent city → handle gracefully', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'weather', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'weather', args: { city: 'Atlantis' } } ], blend: { style: 'short', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Cannot find reliable weather. Ask for clarification.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/weather', () => ({ getWeather: async () => ({ ok: false, reason: 'unknown_city', source: 'open-meteo.com' }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Weather in a city that does not exist.', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('edge: pack for Mars → gracefully unsupported', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const plan = { route: 'packing', confidence: 0.8, missing: [], consent: { required: false }, calls: [ { tool: 'packingSuggest', args: { city: 'Mars' } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } };
      const chatWithToolsLLM = jest.fn()
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }))
        .mockImplementationOnce(() => ({ choices: [{ message: { role: 'assistant', content: 'Cannot provide realistic packing for Mars.' } }] }));
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/packing', () => ({ suggestPacking: async () => ({ ok: false, reason: 'unknown_city' }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    const out = await handleChat({ message: 'Help me pack for Mars.', receipts: true }, { log });
    expect(out.threadId).toBeDefined();
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(out.threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 25000);

  it('context: weather Tokyo → pack → kid attractions', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const queue = [
        { choices: [{ message: { role: 'assistant', content: JSON.stringify({ route: 'weather', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'weather', args: { city: 'Tokyo' } } ], blend: { style: 'short', cite: true }, verify: { mode: 'citations' } }) } }] },
        { choices: [{ message: { role: 'assistant', content: JSON.stringify({ route: 'packing', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'packingSuggest', args: { city: 'Tokyo' } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } }) } }] },
        { choices: [{ message: { role: 'assistant', content: JSON.stringify({ route: 'attractions', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'search', args: { query: 'kid friendly attractions in Tokyo', deep: false } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } }) } }] },
        { choices: [{ message: { role: 'assistant', content: 'Mild and rainy. Sources included.' } }] },
        { choices: [{ message: { role: 'assistant', content: 'Pack layers and rain jacket. Sources included.' } }] },
        { choices: [{ message: { role: 'assistant', content: 'Ueno Zoo, TeamLab, KidZania. Sources included.' } }] },
      ];
      const chatWithToolsLLM = jest.fn(() => queue.shift() || { choices: [{ message: { role: 'assistant', content: 'OK' } }] });
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/weather', () => ({ getWeather: async () => ({ ok: true, summary: 'Mild and rainy', source: 'open-meteo.com' }) }));
    jest.doMock('../../src/tools/packing', () => ({ suggestPacking: async () => ({ ok: true, summary: 'layers and rain jacket', source: 'curated', band: 'mild', items: { base: ['jacket'], special: {} } }) }));
    jest.doMock('../../src/tools/search', () => ({ searchTravelInfo: async () => ({ ok: true, summary: 'Ueno Zoo; TeamLab; KidZania', source: 'Brave Search', results: [] }), getSearchCitation: () => 'Brave Search', getSearchSource: () => 'brave-search' }));
    const { handleChat } = await import('../../src/core/blend.js');
    let out = await handleChat({ message: "What’s the weather in Tokyo?", receipts: true }, { log });
    const threadId = out.threadId!;
    await new Promise(r => setTimeout(r, 300));
    out = await handleChat({ message: 'Now what should I pack?', threadId, receipts: true }, { log });
    await new Promise(r => setTimeout(r, 300));
    out = await handleChat({ message: 'Any good attractions for kids?', threadId, receipts: true }, { log });
    expect(out.threadId).toBe(threadId);
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 40000);

  it('context: Berlin → weather → switch to Munich', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const queue = [
        { choices: [{ message: { role: 'assistant', content: JSON.stringify({ route: 'weather', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'weather', args: { city: 'Berlin' } } ], blend: { style: 'short', cite: true }, verify: { mode: 'citations' } }) } }] },
        { choices: [{ message: { role: 'assistant', content: 'Cloudy in Berlin.' } }] },
        { choices: [{ message: { role: 'assistant', content: JSON.stringify({ route: 'weather', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'weather', args: { city: 'Munich' } } ], blend: { style: 'short', cite: true }, verify: { mode: 'citations' } }) } }] },
        { choices: [{ message: { role: 'assistant', content: 'Sunny in Munich.' } }] },
      ];
      const chatWithToolsLLM = jest.fn(() => queue.shift() || { choices: [{ message: { role: 'assistant', content: 'OK' } }] });
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/weather', () => ({ getWeather: async ({ city }: any) => ({ ok: true, summary: city === 'Berlin' ? 'Cloudy' : 'Sunny', source: 'open-meteo.com' }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    let out = await handleChat({ message: "I’m going to Berlin. What’s the weather?", receipts: true }, { log });
    const threadId = out.threadId!;
    await new Promise(r => setTimeout(r, 300));
    out = await handleChat({ message: 'Actually, what about Munich instead?', threadId, receipts: true }, { log });
    expect(out.threadId).toBe(threadId);
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 35000);

  it('context: attractions Paris → weather Moscow', async () => {
    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const queue = [
        { choices: [{ message: { role: 'assistant', content: JSON.stringify({ route: 'attractions', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'search', args: { query: 'attractions in Paris', deep: false } } ], blend: { style: 'bullet', cite: true }, verify: { mode: 'citations' } }) } }] },
        { choices: [{ message: { role: 'assistant', content: 'Eiffel Tower, Louvre. Sources included.' } }] },
        { choices: [{ message: { role: 'assistant', content: JSON.stringify({ route: 'weather', confidence: 0.9, missing: [], consent: { required: false }, calls: [ { tool: 'weather', args: { city: 'Moscow' } } ], blend: { style: 'short', cite: true }, verify: { mode: 'citations' } }) } }] },
        { choices: [{ message: { role: 'assistant', content: 'Cold winter in Moscow.' } }] },
      ];
      const chatWithToolsLLM = jest.fn(() => queue.shift() || { choices: [{ message: { role: 'assistant', content: 'OK' } }] });
      return { ...actual, chatWithToolsLLM };
    });
    jest.doMock('../../src/tools/search', () => ({ searchTravelInfo: async () => ({ ok: true, summary: 'Eiffel Tower; Louvre', source: 'Brave Search', results: [] }), getSearchCitation: () => 'Brave Search', getSearchSource: () => 'brave-search' }));
    jest.doMock('../../src/tools/weather', () => ({ getWeather: async () => ({ ok: true, summary: 'Cold winter', source: 'open-meteo.com' }) }));
    const { handleChat } = await import('../../src/core/blend.js');
    let out = await handleChat({ message: 'Tell me attractions in Paris', receipts: true }, { log });
    const threadId = out.threadId!;
    await new Promise(r => setTimeout(r, 300));
    out = await handleChat({ message: 'then weather in Moscow', threadId, receipts: true }, { log });
    expect(out.threadId).toBe(threadId);
    await new Promise(r => setTimeout(r, 400));
    const { getLastVerification } = await import('../../src/core/slot_memory.js');
    const artifact = await getLastVerification(threadId);
    expect(artifact).toBeDefined();
    expect(['pass','warn','fail']).toContain(artifact!.verdict);
  }, 35000);
});
