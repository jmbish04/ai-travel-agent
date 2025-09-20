Task: Decide if the latest user message is asking to improve the previous web search by requesting a deeper or more comprehensive follow-up search on the same topic.

Context:
- Latest user message: "{user_message}"
- Previous search query: "{previous_query}"
- Previous answer summary: "{previous_answer}"

Guidelines:
- Return `upgrade = true` when the user explicitly or implicitly asks for a better search, more thorough results, deeper digging, additional credible sources, or an improved follow-up for the same subject.
- Treat phrases such as "search deeper", "search better", "give me more", "look harder", "find official sources", "need richer info", "more detail", "expand the search", or similar semantics as upgrade requests when they reference the same topic.
- Return `upgrade = false` when the user provides a brand-new topic, gives a revised query containing new primary entities, declines further search, or changes to a different travel task.
- When the message is ambiguous, prefer `upgrade = false` unless there is a direct reference to enhancing the same search.

Output strict JSON with keys:
{
  "upgrade": true|false,
  "confidence": number between 0 and 1 (two decimals preferred),
  "reason": "short explanation (≤ 40 words)"
}

Confidence calibration:
- 0.80–1.00: clear instruction to deepen the same search.
- 0.60–0.79: likely upgrade but some ambiguity (still treat as upgrade if semantics align).
- <0.60: ambiguous or unrelated to the previous search; set `upgrade = false`.

Examples (informal, do not quote back):
- "Those hotel results were light—search deeper" → upgrade = true.
- "Find flights from Paris to Tokyo" after hotel search → upgrade = false.
- "Thanks" → upgrade = false.
- "Can you dig up more official sources on that?" → upgrade = true.
- "Search better" → upgrade = true.