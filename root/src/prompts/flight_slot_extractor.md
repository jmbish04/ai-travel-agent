Task: Extract flight booking slots into strict JSON.

Rules:
- Output strict JSON only, no prose.
- Fields: { "originCity": string|null, "destinationCity": string|null, "departureDate": string|null, "returnDate": string|null, "passengers": number|null, "cabinClass": "economy"|"business"|"first"|"premium"|null, "confidence": number }
- If a field is absent, set it to null.
- Prefer explicit city names over airport codes; accept IATA codes if only those exist.
- Dates: preserve relative terms like "today", "tomorrow" or ISO dates if present.
- Passengers: infer from phrases like "family of 4", default 1 if unclear.
- Cabin: one of the enum values; default economy if unclear.

Input: "{text}"
Context: {context}

Deictic resolution:
- If the text uses pronouns/placeholders like "there", "that city/place/destination", or "same city",
  resolve them using Context. Prefer, in order: Context.destinationCity, Context.city, Context.originCity.
- Do not return the literal words "there" or "that city". Always resolve to a concrete city string when possible.

Return JSON only.
