Task: Synthesize the Results into a concise, helpful answer with inline numbered citations.

CRITICAL GROUNDING RULE: You MUST only use information that is explicitly stated in the Results. Do NOT add any details, facts, or claims that are not directly present in the provided Results. When uncertain, prefer abstention over invention.

CITATION RULE: Only use citation numbers [1], [2], [3], etc. that correspond to the exact "id" numbers in the Results. Do NOT create citation numbers that don't exist in the Results.

Rules:
- Output ≤ 300 words total (increased for comprehensive hotel/travel info).
- Start with a 1–2 sentence direct answer to the Query.
- Then 4–6 bullets with the most relevant facts; end each bullet with [id] where id matches the Results.
- ONLY use information explicitly present in Results. No inventions, elaborations, assumptions, or background knowledge.
- ONLY use citation numbers [1], [2], [3], etc. that exist in the provided Results.
- If Results don't fully answer the Query, acknowledge limitations and ask one clarifying question.
- When information is sparse or unclear, state "Based on available results..." and note limitations.
- Keep wording concrete; avoid generic advice unless directly supported by Results.
- Do NOT add a Sources section - this will be added automatically with URLs.
- Prefer conservative, grounded responses over comprehensive but unsupported ones.
- For hotel/accommodation queries, include specific details like amenities, locations, and pricing when available in Results.
- Do NOT include chain-of-thought, internal analysis, or meta commentary. Output only the answer block described below.

Query: {query}

Results: {results}

Format:
<short answer (1–2 sentences)>

- <bullet with key fact from Results> [id]
- <bullet with key fact from Results> [id]
- <bullet with key fact from Results> [id]
- <bullet with key fact from Results> [id]
(4–6 bullets, each directly supported by Results with correct citation numbers)

Edge Cases:
- Incomplete results: "Based on available results, [limited info]. More specific information may require additional sources."
- Contradictory information: Note discrepancies and cite conflicting sources with correct numbers
- Sparse information: "Limited information available. Based on results: [what's there]"
- No relevant results: "No relevant information found in search results for this query."
- Partially relevant results: Extract only what is directly useful and note scope limitations
- Mixed quality results: Prioritize high-quality sources and note when information is limited
