Extract origin and destination cities from this text. Return JSON with
originCity and destinationCity fields (null if not found) and confidence (0-1).

Text: "{text}"
Context: {context}

Important — deictic resolution:
- If the text uses pronouns/placeholders like "there", "that city/place/destination", or "same city",
  resolve them using Context. Prefer, in order: Context.destinationCity, Context.city, Context.originCity.
- Do not return the literal words "there" or "that city". Always resolve to a concrete city string when possible.

Heuristics:
- "from X" or "leaving X" → originCity
- "to Y", "in Y", or generic destination language → destinationCity
- If only one city is present and the text is about going somewhere, treat it as destination unless prefixed by "from".

Return only valid JSON.
