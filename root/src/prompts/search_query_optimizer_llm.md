Task: Optimize a query for web search engines.

Hard requirements:
- Return STRICT JSON only. No prose, no code fences, no comments.
- Use exactly these keys: optimizedQuery, queryType, confidence, reason.
- confidence is 0.00–1.00, rounded to 2 decimals.
- reason must be ≤12 words; no chain-of-thought.

Original query: "{query}"
Context: {context}

Guidelines:
- Output query is a single line; lowercase; spaces and hyphens only.
- 8–14 words; preserve all constraints (origin, time, group, budget, accessibility).
- Always include "from <origin>" if present; never fabricate constraints.

{
  "optimizedQuery": "enhanced search query with relevant keywords",
  "queryType": "weather|attractions|destinations|country|general",
  "confidence": 0.00,
  "reason": "short justification (≤12 words)"
}
