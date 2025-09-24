import type pino from 'pino';
import { getPrompt } from './prompts.js';
import { callLLM } from './llm.js';
import { updateThreadSlots } from './slot_memory.js';

export type UserPreferences = {
  travelStyle?: string | null;
  budgetLevel?: string | null;
  activityType?: string | null;
  groupType?: string | null;
  theme?: string | null; // coastal|mountain|city|island|any
  confidence?: number;
};

export async function ensureUserPreferences(
  threadId: string | undefined,
  message: string,
  slots: Record<string, string>,
  log?: pino.Logger,
): Promise<UserPreferences | undefined> {
  try {
    // Use cached preferences if present
    if (slots.user_preferences) {
      try { return JSON.parse(slots.user_preferences) as UserPreferences; } catch {}
    }

    const tpl = await getPrompt('preference_extractor');
    const prompt = tpl.replace('{text}', message);
    const raw = await callLLM(prompt, { responseFormat: 'json', log });
    const parsed = JSON.parse(raw) as UserPreferences;

    // Normalize theme
    const theme = (parsed.theme || '').toLowerCase();
    if (theme && threadId) {
      await updateThreadSlots(threadId, {
        user_preferences: JSON.stringify(parsed),
        preference_theme: theme,
      }, []);
    } else if (threadId) {
      await updateThreadSlots(threadId, { user_preferences: JSON.stringify(parsed) }, []);
    }

    return parsed;
  } catch (error) {
    log?.debug?.({ error: String(error) }, 'preferences_extraction_failed');
    return undefined;
  }
}

