import { StateGraph, END, Annotation } from '@langchain/langgraph';
import { extractPolicyClause } from '../../tools/policy_browser.js';
import { savePolicyReceipt } from '../../core/policy_receipts.js';
import { scoreDomainAuthenticity } from '../../core/domain_authenticity.js';
import type { PolicyReceipt, ClauseTypeT, DomainScore } from '../../schemas/policy.js';

const PolicyBrowserState = Annotation.Root({
  url: Annotation<string>,
  clause: Annotation<ClauseTypeT>,
  threadId: Annotation<string>,
  airlineName: Annotation<string>,
  receipt: Annotation<PolicyReceipt>,
  domainScore: Annotation<DomainScore>,
  error: Annotation<string>,
  confidence: Annotation<number>
});

/**
 * Route policy extraction request
 */
async function routeExtraction(state: typeof PolicyBrowserState.State) {
  const { url, clause } = state;
  
  if (!url || !clause) {
    return { error: 'Missing required parameters: url and clause' };
  }
  
  try {
    new URL(url); // Validate URL format
  } catch {
    return { error: 'Invalid URL format' };
  }
  
  return state;
}

/**
 * Score domain authenticity before extraction
 */
async function scoreDomain(state: typeof PolicyBrowserState.State) {
  const { url, airlineName } = state;
  
  if (!airlineName) {
    // Skip domain scoring if no airline name provided
    return state;
  }
  
  try {
    const domain = new URL(url).hostname;
    const signal = AbortSignal.timeout(150); // 150ms timeout per requirements
    const domainScore = await scoreDomainAuthenticity(domain, airlineName, signal);
    
    return { domainScore };
  } catch (error) {
    console.warn('Domain scoring failed:', error);
    return state; // Continue without domain score
  }
}

/**
 * Extract policy clause using Crawlee
 */
async function extractClause(state: typeof PolicyBrowserState.State) {
  const { url, clause, threadId, domainScore, airlineName } = state;
  
  try {
    const receipt = await extractPolicyClause({
      url,
      clause,
      airlineName,
      timeoutMs: 15000
    });
    
    // Add domain authenticity metadata to receipt if not already present
    const enhancedReceipt = {
      ...receipt,
      domainAuthenticity: receipt.domainAuthenticity || domainScore
    };
    
    // Save receipt to thread memory
    if (threadId) {
      savePolicyReceipt(threadId, enhancedReceipt);
    }
    
    return {
      receipt: enhancedReceipt,
      confidence: receipt.confidence,
      error: undefined
    };
  } catch (error) {
    return {
      error: `Policy extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      confidence: 0
    };
  }
}

/**
 * Guard against low confidence results
 */
async function confidenceGuard(state: typeof PolicyBrowserState.State) {
  const { confidence, receipt } = state;
  
  if (confidence < 0.6) {
    return {
      error: `Low confidence extraction (${confidence?.toFixed(2)}). Consider manual review.`,
      receipt: undefined
    };
  }
  
  return state;
}

// Build the graph
export const policy_browser_graph = new StateGraph(PolicyBrowserState)
  .addNode('route', routeExtraction)
  .addNode('scoreDomain', scoreDomain)
  .addNode('extract', extractClause)
  .addNode('guard', confidenceGuard)
  .addEdge('route', 'scoreDomain')
  .addEdge('scoreDomain', 'extract')
  .addEdge('extract', 'guard')
  .addEdge('guard', END)
  .setEntryPoint('route')
  .compile();
