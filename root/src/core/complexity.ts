import type { Logger } from 'pino';
import { getPrompt } from './prompts.js';
import { callLLM } from './llm.js';

export type ComplexityAssessment = {
  isComplex: boolean;
  confidence: number;
  reasoning: string;
};

export async function assessQueryComplexity(message: string, log?: Logger): Promise<ComplexityAssessment> {
  const promptTemplate = await getPrompt('complexity_assessor');
  const safeMessage = JSON.stringify(message);
  const prompt = promptTemplate.replace('{message}', safeMessage ?? '""');

  try {
    const raw = await callLLM(prompt, { responseFormat: 'json', log });
    const parsed = JSON.parse(raw) as ComplexityAssessment;
    return {
      isComplex: Boolean(parsed.isComplex),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (error) {
    log?.debug({ error: String(error) }, 'complexity_assessor_failed');
    return { isComplex: false, confidence: 0, reasoning: 'llm_error' };
  }
}

