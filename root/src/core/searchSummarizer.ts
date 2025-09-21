import { getPrompt } from './prompts.js';
import { callLLM } from './llm.js';
import { getSearchCitation } from '../tools/search.js';

export async function summarizeSearch(
  results: Array<{ title: string; url: string; description: string }>,
  query: string,
  useLLM: boolean,
  ctx: { log: any },
): Promise<{ reply: string; citations: string[] }> {
  if (!useLLM || results.length <= 1) {
    return formatSearchResultsDeterministic(results);
  }

  try {
    const promptTemplate = await getPrompt('search_summarize');
    const topResults = results.slice(0, 7);
    const formattedResults = topResults.map((result, index) => ({
      id: index + 1,
      title: result.title.replace(/<[^>]*>/g, ''),
      url: result.url,
      description: result.description.replace(/<[^>]*>/g, '').slice(0, 200)
    }));
    
    const prompt = promptTemplate
      .replace('{query}', query)
      .replace('{results}', JSON.stringify(formattedResults, null, 2));
    
    const response = await callLLM(prompt, { log: ctx.log });
    let sanitized = response
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    
    if (sanitized.length > 2000) {
      const sentences = sanitized.split(/[.!?]+/);
      let truncated = '';
      for (const sentence of sentences) {
        if ((truncated + sentence).length > 1900) break;
        truncated += sentence + '.';
      }
      sanitized = truncated;
    }
    
    // Always add sources section with URLs, regardless of what LLM generated
    const sourcesBlock = ['Sources:', ...formattedResults.map(r => `${r.id}. ${r.title} - ${r.url}`)].join('\n');
    
    // Remove any existing Sources section from LLM response to avoid duplication
    const cleanedResponse = sanitized.replace(/Sources:\s*[\s\S]*$/i, '').trim();
    
    const finalText = `${cleanedResponse}\n\n${sourcesBlock}`;
    return {
      reply: finalText,
      citations: [getSearchCitation()]
    };
  } catch {
    return formatSearchResultsDeterministic(results);
  }
}

function formatSearchResultsDeterministic(
  results: Array<{ title: string; url: string; description: string }>
): { reply: string; citations: string[] } {
  const topResults = results.slice(0, 3);
  const formattedResults = topResults.map((result, index) => {
    const cleanTitle = result.title.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '');
    const cleanDesc = result.description.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '');
    const truncatedDesc = cleanDesc.slice(0, 150) + (cleanDesc.length > 150 ? '...' : '');
    return `• ${cleanTitle} - ${truncatedDesc}`;
  }).join('\n');
  
  const sourcesBlock = topResults.map((result, index) => 
    `${index + 1}. ${result.title.replace(/<[^>]*>/g, '')} - ${result.url}`
  ).join('\n');
  
  return {
    reply: `Based on web search results:\n\n${formattedResults}\n\nSources:\n${sourcesBlock}`,
    citations: [getSearchCitation()]
  };
}
