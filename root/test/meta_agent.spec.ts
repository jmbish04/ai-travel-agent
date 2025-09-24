import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import pino from 'pino';
import { callChatWithTools } from '../src/agent/tools/index.js';
import * as llm from '../src/core/llm.js';
import * as weather from '../src/tools/weather.js';
import * as flights from '../src/tools/amadeus_flights.js';

const silentLog = pino({ level: 'silent' });

describe('callChatWithTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves weather tool with relative date and records citations', async () => {
    const plan = { route: 'weather', confidence: 0.92 };
    const toolCall = {
      id: 'call_weather',
      type: 'function' as const,
      function: {
        name: 'weather',
        arguments: JSON.stringify({ city: 'Paris', dates: 'today' }),
      },
    };

    const llmMock = jest.spyOn(llm, 'chatWithToolsLLM')
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(plan) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [toolCall] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Paris forecast: sunny.' } }] });

    const weatherSpy = jest.spyOn(weather, 'getWeather').mockResolvedValue({
      ok: true,
      summary: 'Sunny 23°C, light winds',
      source: 'unit-weather',
    });

    const out = await callChatWithTools({
      system: 'SYSTEM_PROMPT',
      user: 'Weather in Paris today',
      maxSteps: 4,
      timeoutMs: 5_000,
      log: silentLog,
    });

    expect(llmMock).toHaveBeenCalledTimes(3);
    expect(weatherSpy).toHaveBeenCalledTimes(1);
    expect(weatherSpy).toHaveBeenCalledWith({ city: 'Paris', month: undefined, dates: 'today' });
    expect(out.reply).toBe('Paris forecast: sunny.');
    expect(out.citations).toEqual(['unit-weather']);
  });

  it('calls Amadeus flight search with city names', async () => {
    const plan = { route: 'flights', confidence: 0.88 };
    const toolCall = {
      id: 'call_flights',
      type: 'function' as const,
      function: {
        name: 'amadeusSearchFlights',
        arguments: JSON.stringify({
          origin: 'New York',
          destination: 'London',
          departureDate: 'tomorrow',
          passengers: 1,
        }),
      },
    };

    const llmMock = jest.spyOn(llm, 'chatWithToolsLLM')
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(plan) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [toolCall] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Top flights summarized.' } }] });

    const flightsSpy = jest.spyOn(flights, 'searchFlights').mockResolvedValue({
      ok: true,
      summary: 'NYC → LON tomorrow · nonstop',
      source: 'amadeus',
    } as any);

    const out = await callChatWithTools({
      system: 'SYSTEM_PROMPT',
      user: 'Find flights from New York to London tomorrow',
      maxSteps: 5,
      timeoutMs: 8_000,
      log: silentLog,
    });

    expect(llmMock).toHaveBeenCalledTimes(3);
    expect(flightsSpy).toHaveBeenCalledTimes(1);
    expect(out.citations).toEqual(['amadeus']);
    expect(out.reply).toBe('Top flights summarized.');
  });

  it('handles low confidence by returning clarifying reply without tool calls', async () => {
    const plan = { route: 'weather', confidence: 0.42 };

    const llmMock = jest.spyOn(llm, 'chatWithToolsLLM')
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(plan) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Which city and dates are you interested in?' } }] });

    const weatherSpy = jest.spyOn(weather, 'getWeather').mockResolvedValue({
      ok: true,
      summary: 'unused',
    });

    const out = await callChatWithTools({
      system: 'SYSTEM_PROMPT',
      user: 'Tell me the weather',
      maxSteps: 3,
      timeoutMs: 4_000,
      log: silentLog,
    });

    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(weatherSpy).not.toHaveBeenCalled();
    expect(out.reply).toBe('Which city and dates are you interested in?');
    expect(out.citations).toEqual([]);
  });
});

