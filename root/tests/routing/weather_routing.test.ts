import pino from 'pino';

const log = pino({ level: (process.env.LOG_LEVEL as any) || 'silent' });

describe('Routing: weather uses dedicated weather tool', () => {
  beforeAll(() => {
    jest.resetModules();
  });

  it('gates generic search for weather route and exposes only weather tool', async () => {
    const toolNamesPerCall: string[][] = [];

    jest.doMock('../../src/core/llm', () => {
      const actual = jest.requireActual('../../src/core/llm');
      const chatWithToolsLLM = jest
        .fn()
        // Planning pass: return a plan that incorrectly tries to use `search` for weather
        .mockImplementationOnce(() => ({
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                route: 'weather',
                confidence: 1.0,
                missing: [],
                consent: { required: false },
                calls: [
                  { tool: 'search', args: { query: 'current weather in London', deep: false }, timeoutMs: 2000 },
                ],
                blend: { style: 'short', cite: true },
                verify: { mode: 'none' },
              }),
            },
          }],
        }))
        // Execution pass: record allowed tools and return no tool calls to end quickly
        .mockImplementationOnce((args: any) => {
          const tools = (args?.tools || []) as Array<any>;
          toolNamesPerCall.push(tools.map((t) => t?.function?.name).filter(Boolean));
          return { choices: [{ message: { role: 'assistant', content: 'Weather check stub.' } }] };
        });
      return { ...actual, chatWithToolsLLM };
    });

    const { callChatWithTools } = await import('../../src/agent/tools/index.js');
    const out = await callChatWithTools({
      system: 'test-system',
      user: 'What is the weather in London?',
      context: {},
      maxSteps: 2,
      timeoutMs: 4000,
      log,
    });

    // Assert that, during execution, only the `weather` tool was exposed
    expect(toolNamesPerCall.length).toBeGreaterThan(0);
    const names = toolNamesPerCall[0];
    expect(names).toContain('weather');
    expect(names).not.toContain('search');

    expect(out.result).toBeDefined();
  }, 10000);
});

