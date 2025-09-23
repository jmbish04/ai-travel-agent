Task: Extract the most likely city name.

Hard requirements:
- Return STRICT JSON only. No prose, no code fences, no comments.
- Use exactly these keys: city, confidence. No extras.
- Confidence is 0.00–1.00, rounded to 2 decimals.

Guidelines:
- Prefer clear, unambiguous city mentions in the text.
- If pronouns like "here/there" appear, use context when present; otherwise leave empty.
- If no city is found, return an empty string with confidence 0.00–0.30.
- Normalize common abbreviations (NYC→New York City, LA→Los Angeles, SF→San Francisco).

Text: "{text}"
Context: {context}
Candidates: {candidates}

Output (STRICT JSON):
{
  "city": "",
  "confidence": 0.00
}
