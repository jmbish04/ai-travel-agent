import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

type PromptName =
  | 'meta_agent'
  | 'verify'
  | 'planner'
  | 'consent_detector'
  | 'complexity_assessor'
  | 'city_parser'
  | 'date_parser'
  | 'nlp_city_extraction'
  | 'nlp_clarifier'
  | 'nlp_intent_detection'
  | 'nlp_content_classification'
  | 'search_summarize'
  | 'search_query_optimizer'
  | 'search_extract_weather'
  | 'search_extract_country'
  | 'search_extract_attractions'
  | 'country_disambiguator'
  | 'attractions_kid_friendly'
  | 'attractions_summarizer'
  | 'preference_extractor'
  | 'origin_destination_extractor'
  | 'policy_confidence'
  | 'policy_extractor'
  | 'flight_slot_extractor'
  | 'domain_authenticity_classifier'
  | 'crawlee_page_summary'
  | 'crawlee_overall_summary'
  | 'llm_test_evaluator';

let loaded = false;
const PROMPTS: Partial<Record<PromptName, string>> = {};
const memo = new Map<string, string>();

async function loadFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export async function preloadPrompts(): Promise<void> {
  if (loaded) return;

  const candidates: string[] = [];
  if (process.env.PROMPTS_DIR) candidates.push(path.resolve(process.env.PROMPTS_DIR));
  candidates.push(path.join(process.cwd(), 'src', 'prompts'));
  candidates.push(path.join(process.cwd(), 'root', 'src', 'prompts'));
  const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  candidates.push(path.join(here, '..', 'prompts'));

  const base = candidates.find((c) => fs.existsSync(c)) || path.join(process.cwd(), 'src', 'prompts');

  const assign = async (name: PromptName, file: string) => {
    PROMPTS[name] = await loadFileSafe(path.join(base, file));
  };

  await Promise.all([
    assign('meta_agent', 'meta_agent.md'),
    assign('planner', 'planner.md'),
    assign('verify', 'verify.md'),
    assign('consent_detector', 'consent_detector.md'),
    assign('complexity_assessor', 'complexity_assessor.md'),
    assign('city_parser', 'city_parser.md'),
    assign('date_parser', 'date_parser.md'),
    assign('nlp_city_extraction', 'nlp_city_extraction.md'),
    assign('nlp_clarifier', 'nlp_clarifier.md'),
    assign('nlp_intent_detection', 'nlp_intent_detection.md'),
    assign('nlp_content_classification', 'nlp_content_classification.md'),
    assign('search_summarize', 'search_summarize.md'),
    assign('search_query_optimizer', 'search_query_optimizer.md'),
    assign('search_extract_weather', 'search_extract_weather.md'),
    assign('search_extract_country', 'search_extract_country.md'),
    assign('search_extract_attractions', 'search_extract_attractions.md'),
    assign('country_disambiguator', 'country_disambiguator.md'),
    assign('attractions_kid_friendly', 'attractions_kid_friendly.md'),
    assign('attractions_summarizer', 'attractions_summarizer.md'),
    assign('preference_extractor', 'preference_extractor.md'),
    assign('origin_destination_extractor', 'origin_destination_extractor.md'),
    assign('policy_confidence', 'policy_confidence.md'),
    assign('policy_extractor', 'policy_extractor.md'),
    assign('flight_slot_extractor', 'flight_slot_extractor.md'),
    assign('domain_authenticity_classifier', 'domain_authenticity_classifier.md'),
    assign('crawlee_page_summary', 'crawlee_page_summary.md'),
    assign('crawlee_overall_summary', 'crawlee_overall_summary.md'),
    assign('llm_test_evaluator', 'llm_test_evaluator.md'),
  ]);

  loaded = true;
}

export async function getPrompt(name: PromptName): Promise<string> {
  if (memo.has(name)) return memo.get(name)!;
  if (!loaded) await preloadPrompts();
  const text = PROMPTS[name] ?? '';
  memo.set(name, text);
  return text;
}
