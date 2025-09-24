import { StateGraph, END, Annotation } from '@langchain/langgraph';
import { runMetaAgentTurn } from '../meta_agent.js';

const S = Annotation.Root({
  message: Annotation<string>,
  threadId: Annotation<string>,
  reply: Annotation<string | undefined>,
  citations: Annotation<string[] | undefined>,
});

export function buildMetaGraph() {
  return new StateGraph(S)
    .addNode('MetaAgent', async (st: typeof S.State) => {
      const out = await runMetaAgentTurn(st.message, st.threadId, {});
      return { reply: out.reply, citations: out.citations } as Partial<typeof S.State>;
    })
    .addEdge('MetaAgent', END)
    .setEntryPoint('MetaAgent')
    .compile();
}

