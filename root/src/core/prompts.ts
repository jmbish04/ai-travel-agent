import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

type PromptName =
  | 'system'
  | 'blend'
  | 'blend_planner'
  | 'cot'
  | 'verify'
  | 'consent_detector'
  | 'search_upgrade_detector'
  | 'context_switch_detector'
  | 'city_parser'
  | 'date_parser'
  | 'router_llm'
  | 'nlp_city_extraction'
  | 'nlp_clarifier'
  | 'nlp_intent_detection'
  | 'nlp_content_classification'
  | 'search_summarize'
  | 'search_query_optimizer'
  | 'search_extract_weather'
  | 'search_extract_country'
  | 'search_extract_attractions'
  | 'complexity_assessor'
  | 'iata_code_generator'
  | 'policy_summarizer'
  | 'policy_classifier'
  | 'policy_extractor'
  | 'policy_confidence'
  | 'policy_quality_assessor'
  | 'search_result_extractor'
  | 'preference_extractor'
  | 'attractions_kid_friendly'
  | 'origin_destination_extractor'
  | 'attractions_summarizer'
  | 'country_disambiguator'
  | 'crawlee_page_summary'
  | 'crawlee_overall_summary'
  | 'destination_summarizer'
  | 'llm_test_evaluator'
  | 'entity_extraction_retry'
  | 'citation_analysis'
  | 'citation_verification'
  | 'flight_slot_extractor'
  | 'domain_authenticity_classifier';

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
  // Resolve prompts directory with robust fallback
  const candidates: string[] = [];
  if (process.env.PROMPTS_DIR) {
    candidates.push(path.resolve(process.env.PROMPTS_DIR));
  }
  candidates.push(path.join(process.cwd(), 'src', 'prompts'));
  candidates.push(path.join(process.cwd(), 'root', 'src', 'prompts'));
  // Relative to this file location (works under ts-jest CJS transform)
  // __dirname should be root/src/core at runtime
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  candidates.push(path.join(here, '..', 'prompts'));
  
  const base = candidates.find((c) => fs.existsSync(c)) || path.join(process.cwd(), 'src', 'prompts');
  PROMPTS.system = await loadFileSafe(path.join(base, 'system.md'));
  PROMPTS.blend = await loadFileSafe(path.join(base, 'blend.md'));
  PROMPTS.blend_planner = await loadFileSafe(path.join(base, 'blend_planner.md'));
  PROMPTS.cot = await loadFileSafe(path.join(base, 'cot.md'));
  PROMPTS.verify = await loadFileSafe(path.join(base, 'verify.md'));
  PROMPTS.consent_detector = await loadFileSafe(
    path.join(base, 'consent_detector.md'),
  );
  PROMPTS.search_upgrade_detector = await loadFileSafe(
    path.join(base, 'search_upgrade_detector.md'),
  );
  PROMPTS.city_parser = await loadFileSafe(
    path.join(base, 'city_parser.md'),
  );
  PROMPTS.date_parser = await loadFileSafe(
    path.join(base, 'date_parser.md'),
  );
  PROMPTS.router_llm = await loadFileSafe(
    path.join(base, 'router_llm.md'),
  );
  PROMPTS.nlp_city_extraction = await loadFileSafe(
    path.join(base, 'nlp_city_extraction.md'),
  );
  PROMPTS.nlp_clarifier = await loadFileSafe(
    path.join(base, 'nlp_clarifier.md'),
  );
  // Unify intent detection with the primary router prompt to avoid drift
  // Use router_llm template for both initial route and fallback classification
  PROMPTS.nlp_intent_detection = PROMPTS.router_llm || await loadFileSafe(
    path.join(base, 'nlp_intent_detection.md'),
  );
  PROMPTS.nlp_content_classification = await loadFileSafe(
    path.join(base, 'nlp_content_classification.md'),
  );
  PROMPTS.search_summarize = await loadFileSafe(
    path.join(base, 'search_summarize.md'),
  );
  PROMPTS.search_query_optimizer = await loadFileSafe(
    path.join(base, 'search_query_optimizer.md'),
  );
  PROMPTS.search_extract_weather = await loadFileSafe(
    path.join(base, 'search_extract_weather.md'),
  );
  PROMPTS.search_extract_country = await loadFileSafe(
    path.join(base, 'search_extract_country.md'),
  );
  PROMPTS.search_extract_attractions = await loadFileSafe(
    path.join(base, 'search_extract_attractions.md'),
  );
  PROMPTS.iata_code_generator = await loadFileSafe(
    path.join(base, 'iata_code_generator.md'),
  );
  PROMPTS.complexity_assessor = await loadFileSafe(
    path.join(base, 'complexity_assessor.md'),
  );
  PROMPTS.policy_summarizer = await loadFileSafe(
    path.join(base, 'policy_summarizer.md'),
  );
  PROMPTS.policy_classifier = await loadFileSafe(
    path.join(base, 'policy_classifier.md'),
  );
  // Load extractor and confidence prompts for policy browser
  PROMPTS.policy_extractor = await loadFileSafe(
    path.join(base, 'policy_extractor.md'),
  );
  PROMPTS.policy_confidence = await loadFileSafe(
    path.join(base, 'policy_confidence.md'),
  );
  PROMPTS.policy_quality_assessor = await loadFileSafe(
    path.join(base, 'policy_quality_assessor.md'),
  );
  PROMPTS.search_result_extractor = await loadFileSafe(
    path.join(base, 'search_result_extractor.md'),
  );
  PROMPTS.preference_extractor = await loadFileSafe(
    path.join(base, 'preference_extractor.md'),
  );
  PROMPTS.attractions_kid_friendly = await loadFileSafe(
    path.join(base, 'attractions_kid_friendly.md'),
  );
  PROMPTS.origin_destination_extractor = await loadFileSafe(
    path.join(base, 'origin_destination_extractor.md'),
  );
  PROMPTS.attractions_summarizer = await loadFileSafe(
    path.join(base, 'attractions_summarizer.md'),
  );
  PROMPTS.country_disambiguator = await loadFileSafe(
    path.join(base, 'country_disambiguator.md'),
  );
  PROMPTS.crawlee_page_summary = await loadFileSafe(
    path.join(base, 'crawlee_page_summary.md'),
  );
  PROMPTS.crawlee_overall_summary = await loadFileSafe(
    path.join(base, 'crawlee_overall_summary.md'),
  );
  PROMPTS.destination_summarizer = await loadFileSafe(
    path.join(base, 'destination_summarizer.md'),
  );
  PROMPTS.llm_test_evaluator = await loadFileSafe(
    path.join(base, 'llm_test_evaluator.md'),
  );
  PROMPTS.entity_extraction_retry = await loadFileSafe(
    path.join(base, 'entity_extraction_retry.md'),
  );
  PROMPTS.citation_analysis = await loadFileSafe(
    path.join(base, 'citation_analysis.md'),
  );
  PROMPTS.citation_verification = await loadFileSafe(
    path.join(base, 'citation_verification.md'),
  );
  PROMPTS.flight_slot_extractor = await loadFileSafe(
    path.join(base, 'flight_slot_extractor.md'),
  );
  PROMPTS.domain_authenticity_classifier = await loadFileSafe(
    path.join(base, 'domain_authenticity_classifier.md'),
  );
  loaded = true;
}

export async function getPrompt(name: PromptName): Promise<string> {
  if (memo.has(name)) return memo.get(name)!;
  if (!loaded) await preloadPrompts();
  const text = PROMPTS[name] ?? '';
  memo.set(name, text);
  return text;
}
