export type ConsentMessageType = 'deep' | 'web_after_rag' | 'verify_fail';

export interface ConsentMessageOptions {
  reason?: string;
}

const deepResearchMessage = [
  'This request has several constraints and would benefit from a deeper web research pass.',
  'If you\'re okay with it, reply "yes" and I\'ll gather tailored options.',
  'Otherwise, feel free to refine the details.'
].join(' ');

function buildWebAfterRagMessage(reason?: string): string {
  const prefix = reason
    ? `I couldn't find sufficient information in our internal knowledge base (${reason}).`
    : 'I couldn\'t find sufficient information in our internal knowledge base.';
  return [
    prefix,
    'If you\'re okay with it, reply "yes" and I\'ll search for current information;',
    'otherwise, feel free to refine the question.'
  ].join(' ');
}

const verifyFailMessage = [
  'I don\'t have high-confidence sources for that.',
  'If you\'re okay with it, I can run a quick web search for up-to-date information.',
  'Reply "yes" to proceed, or share more details to refine the query.'
].join(' ');

export function getConsentMessage(
  type: ConsentMessageType,
  options: ConsentMessageOptions = {}
): string {
  switch (type) {
    case 'deep':
      return deepResearchMessage;
    case 'web_after_rag':
      return buildWebAfterRagMessage(options.reason);
    case 'verify_fail':
      return verifyFailMessage;
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unknown consent message type: ${exhaustiveCheck}`);
    }
  }
}
