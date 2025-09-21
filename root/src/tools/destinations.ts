import { getCountryFacts } from './country.js';
import { extractTravelPreferences } from '../core/preference-extractor.js';
import { callLLM } from '../core/llm.js';
import { getPrompt } from '../core/prompts.js';
import type pino from 'pino';

export interface DestinationFact {
  source: string;
  key: string;
  value: {
    city: string;
    country: string;
    tags: {
      climate: string;
      budget: string;
      family_friendly: boolean;
    };
  };
  url?: string;
}

export interface Slots {
  city?: string;
  month?: string;
  dates?: string;
  travelerProfile?: string;
  budget?: string;
  climate?: string;
}

export async function recommendDestinations(
  slots: Slots, 
  log?: pino.Logger
): Promise<DestinationFact[]> {
  let rawResponse = '';
  try {
    const preferences = await extractTravelPreferences(slots.travelerProfile || '', log);
    log?.debug({ slots, preferences }, 'destinations_tool_input');

    const tpl = await getPrompt('destinations_recommender');
    const prompt = tpl
      .replace('{preferences}', JSON.stringify(preferences))
      .replace('{slots}', JSON.stringify(slots));
    
    log?.debug({ prompt: prompt.slice(0, 500) + '...' }, 'destinations_tool_prompt');

    rawResponse = await callLLM(prompt, { responseFormat: 'json', log });
    log?.debug({ rawResponse, slots }, 'destinations_tool_raw_response');
    
    // Try to extract JSON from response if it contains extra text
    let jsonStr = rawResponse.trim();
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    let recommendations = JSON.parse(jsonStr);
    log?.debug({ recommendations, originalSlots: slots }, 'destinations_tool_parsed_recommendations');
    
    // Handle case where LLM returns single object instead of array
    if (!Array.isArray(recommendations)) {
      if (typeof recommendations === 'object' && recommendations.city) {
        recommendations = [recommendations];
      } else {
        throw new Error('Expected array of recommendations or single recommendation object');
      }
    }

    // Format the LLM response into the DestinationFact structure
    const result = recommendations.map((rec: any) => ({
      source: 'LLM Recommendation',
      key: 'destination',
      value: {
        city: rec.city || 'Unknown City',
        country: rec.country || 'Unknown Country',
        tags: rec.tags || { climate: 'unknown', budget: 'mid', family_friendly: false }
      },
      url: `Generated recommendation for ${rec.city || 'destination'}`
    }));
    
    log?.debug({ result, inputSlots: slots }, 'destinations_tool_final_result');
    return result;

  } catch (e) {
    log?.error({ error: e, rawResponse, slots }, 'Failed to get AI-driven destinations');
    return [];
  }
}