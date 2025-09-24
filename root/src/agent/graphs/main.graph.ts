import { StateGraph, END, Annotation } from '@langchain/langgraph';
import pino from 'pino';
import { routeIntent } from '../../core/router.js';
import { runGraphTurn } from '../../core/graph.js';
import { readConsentState, writeConsentState, getThreadSlots } from '../../core/slot_memory.js';
import { classifyConsentResponse } from '../../core/consent.js';

type RouterLite = {
  intent: string;
  needExternal: boolean;
  slots: Record<string, string>;
  confidence: number;
};

const MainGraphState = Annotation.Root({
  message: Annotation<string>,
  threadId: Annotation<string>,
  router: Annotation<RouterLite | undefined>,
  missing: Annotation<string[] | undefined>,
  reply: Annotation<string | undefined>,
  citations: Annotation<string[] | undefined>,
  done: Annotation<boolean | undefined>,
  guard: Annotation<{ awaiting: boolean; verdict?: 'yes' | 'no' | 'unclear'; type?: 'web' | 'deep' | 'web_after_rag' | '' } | undefined>,
});

function checkMissingSlots(intent: string, slots: Record<string, string>, message: string): string[] {
  const missing: string[] = [];
  const needsLocation = ['attractions', 'packing', 'destinations', 'weather', 'flights'].includes(intent);
  const hasOrigin = !!slots.originCity?.trim();
  const hasDestination = !!(slots.destinationCity?.trim() || slots.city?.trim());
  const hasLocation = intent === 'flights'
    ? hasOrigin && hasDestination
    : intent === 'destinations'
      ? !!(slots.city?.trim() || slots.originCity?.trim() || slots.region?.trim())
      : !!slots.city?.trim();

  if (intent === 'flights') {
    if (!hasOrigin && !hasDestination) {
      missing.push('city');
    } else {
      if (!hasOrigin) missing.push('origin');
      if (!hasDestination) missing.push('destination');
    }
  } else if (needsLocation && !hasLocation) {
    missing.push('location');
  }
  return missing;
}

async function guardNode(state: typeof MainGraphState.State) {
  const slots = await getThreadSlots(state.threadId);
  const consent = readConsentState(slots);
  let verdict: 'yes' | 'no' | 'unclear' | undefined;
  if (consent.awaiting && consent.pending) {
    verdict = await classifyConsentResponse(state.message);
    // For observability only; do not mutate consent state here.
  }
  return { guard: { awaiting: consent.awaiting, verdict, type: (consent as any).type } };
}

async function routeNode(state: typeof MainGraphState.State) {
  const r = await routeIntent({ message: state.message, threadId: state.threadId });
  const filteredSlots: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.slots || {})) {
    if (typeof v === 'string') filteredSlots[k] = v;
  }
  const router: RouterLite = { intent: r.intent, needExternal: r.needExternal, slots: filteredSlots, confidence: r.confidence };
  return { router };
}

async function clarifyNode(state: typeof MainGraphState.State) {
  const intent = state.router?.intent || 'unknown';
  const slots = state.router?.slots || {};
  const missing = checkMissingSlots(intent, slots, state.message);
  return { missing };
}

async function actNode(state: typeof MainGraphState.State) {
  // Delegate to existing implementation for behavior parity
  const log = pino({ level: 'silent' });
  const result = await runGraphTurn(state.message, state.threadId, { log });
  if ('done' in result && result.done) {
    return { done: true, reply: result.reply, citations: result.citations || [] };
  }
  return {} as any; // Non-terminal fallback (should not occur with current runGraphTurn)
}

export function buildMainGraph() {
  return new StateGraph(MainGraphState)
    .addNode('Guard', guardNode)
    .addNode('Route', routeNode)
    .addNode('Clarify', clarifyNode)
    .addNode('Act', actNode)
    .addEdge('Guard', 'Route')
    .addEdge('Route', 'Clarify')
    .addEdge('Clarify', 'Act')
    .addEdge('Act', END)
    .setEntryPoint('Guard')
    .compile();
}

export async function runMainGraphTurn(
  message: string,
  threadId: string,
): Promise<{ reply: string; citations?: string[]; state: typeof MainGraphState.State }> {
  const app = buildMainGraph();
  const initial = { message, threadId } as typeof MainGraphState.State;
  const finalState = await app.invoke(initial);
  return { reply: finalState.reply || '', citations: finalState.citations, state: finalState };
}
