Task: Classify intent and extract slots. Return strict JSON only.

Objective: Accurately determine user intent and extract relevant information slots to enable appropriate routing and response generation.

Hard requirements:
- Output exactly one JSON object. No code fences, no prose, no trailing commas.
- Use only the keys in the schema. Do not add comments or extra fields.
- Round `confidence` to two decimals.

Guidelines:
- Use the output schema exactly. No extra keys. No comments.
- Normalize entities:
  - `intent` ∈ {"destinations","packing","attractions","weather","flights","irrops","policy","web_search","system","unknown"}
  - `city`: expand common abbreviations (e.g., NYC → New York City, LA → Los Angeles)
  - `originCity`: departure city for flights (e.g., "Tel Aviv", "New York City")
  - `destinationCity`: arrival city for flights (e.g., "Moscow", "Paris")
  - `month`: full month name (e.g., "June"); if a date range implies a month, infer the month name
  - `dates`: concise human-readable span if present (e.g., "2025-06-12 to 2025-06-18" or "June 2025" or "today")
  - `travelerProfile`: short phrase like "family with kids", "solo traveler", "couple", "business"
- `needExternal` is true when the user asks for current facts (weather now/forecast, prices, live events, visa rules, flight searches); false for evergreen advice (packing lists, generic attractions without live data)
- Set `confidence` in [0,1]; use ≤0.5 if intent is ambiguous

Intent Classification Rules:
- `flights`: ANY flight-related query including "flights", "fly", "book flight", "airline", flight prices, flight schedules, flight booking, travel from X to Y with dates
- `irrops`: Flight disruptions, cancellations, delays, rebooking requests, equipment changes, missed connections, "my flight was cancelled", "flight delayed", "need to rebook"
- `policy`: Visa requirements, immigration rules, passport info, entry requirements, travel policies
- `web_search`: Explicit search requests ("search for", "find information about"), complex multi-constraint queries, research requests, ANY hotel/accommodation/lodging query (e.g., "best hotels in Bangkok", "hotel near LAX", "accommodation in Tokyo"), AND general information about specific places (e.g., "tell me about Paris", "what's Paris like?")
- `system`: Questions about the AI assistant, consent responses, clarifications, app functionality
- `destinations`: Travel destination recommendations, "where should I go" questions, asking for destination suggestions (NOT asking about specific places)
- `weather`: Weather forecasts, climate information, temperature queries
- `packing`: What to pack, clothing advice, luggage recommendations
- `attractions`: Things to do, sightseeing, activities, tourist attractions

Key Distinction:
- "Where should I go?" or "Recommend destinations" → destinations intent
- "Tell me about Paris" or "What's Paris like?" → web_search intent (for comprehensive city information)

CRITICAL: Flight Intent Recognition
- ANY mention of "flights", "fly", "flying", "book", "travel" with two cities = flights intent
- Patterns that are ALWAYS flights: "flights from X to Y", "find flights", "book flight", "fly from X to Y", "travel from X to Y on [date]"
- "Find flights from Paris to Tokyo on October 15th" = flights intent (confidence 0.95+)
- Do NOT classify flight queries as web_search unless explicitly asking to "search for flight information"

Flight Slot Extraction Rules:
- For flight queries, always extract `originCity` and `destinationCity` when both are present
- If only one city is mentioned, use context to determine if it's origin or destination
- Common patterns: "flights from X to Y", "fly from X to Y", "X to Y flights", "going from X to Y"
- For "flights to Y from X" → originCity: X, destinationCity: Y
- For "flights from X to Y" → originCity: X, destinationCity: Y
- For "Y flights from X" → originCity: X, destinationCity: Y

Confidence Calibration Guidelines:
- 0.80-1.00: Clear intent with all required slots present
- 0.50-0.79: Clear intent but with some missing or ambiguous slots
- 0.20-0.49: Ambiguous intent that could belong to multiple categories
- 0.00-0.19: No clear travel-related intent detected

Multilingual Handling:
- For non-English inputs, translate internally while preserving location names
- Confidence may be slightly lower (0.1-0.2) for non-English inputs due to translation uncertainty
- Maintain the same slot extraction rules regardless of input language
- When translating, preserve cultural context and travel-specific terminology
- For languages with different script systems (e.g., Cyrillic, Chinese), ensure accurate transliteration of city names
- Handle mixed-language inputs by processing each language segment appropriately

User: {message}

Output schema (strict JSON only):
{
  "intent": "destinations|packing|attractions|weather|flights|irrops|policy|web_search|system|unknown",
  "needExternal": true|false,
  "slots": {"city": "...", "originCity": "...", "destinationCity": "...", "month": "...", "dates": "...", "travelerProfile": "..."},
  "confidence": 0..1
}

Few‑shot examples (input → output, strict JSON):
Input: "Find flights from Paris to Tokyo on October 15th"
Output: {"intent":"flights","needExternal":true,"slots":{"originCity":"Paris","destinationCity":"Tokyo","month":"October","dates":"October 15th"},"confidence":0.95}

Input: "flights from Paris to Tokyo"
Output: {"intent":"flights","needExternal":true,"slots":{"originCity":"Paris","destinationCity":"Tokyo"},"confidence":0.90}

Input: "book a flight to Tokyo from Paris tomorrow"
Output: {"intent":"flights","needExternal":true,"slots":{"originCity":"Paris","destinationCity":"Tokyo","dates":"tomorrow"},"confidence":0.95}

Input: "what's the weather in NYC in June?"
Output: {"intent":"weather","needExternal":true,"slots":{"city":"New York City","month":"June","dates":"June"},"confidence":0.90}

Input: "what to pack for Tokyo in March"
Output: {"intent":"packing","needExternal":false,"slots":{"city":"Tokyo","month":"March","dates":"March"},"confidence":0.85}

Input: "What to wear to Haifa today?"
Output: {"intent":"packing","needExternal":true,"slots":{"city":"Haifa","dates":"today"},"confidence":0.90}

Input: "What to wear to Hafia toda?"
Output: {"intent":"packing","needExternal":true,"slots":{"city":"Haifa","dates":"today"},"confidence":0.80}

Input: "Any festivals or events that week?"
Output: {"intent":"unknown","needExternal":true,"slots":{},"confidence":0.90}

Input: "what to do there?"
Output: {"intent":"attractions","needExternal":false,"slots":{},"confidence":0.40}

Input: "My flight AA123 was cancelled, please help me rebook"
Output: {"intent":"irrops","needExternal":true,"slots":{"originCity":"","destinationCity":""},"confidence":0.95}

Input: "Flight delayed 3 hours due to weather, need alternatives"
Output: {"intent":"irrops","needExternal":true,"slots":{},"confidence":0.90}

Input: "Equipment changed from 777 to 737, any issues?"
Output: {"intent":"irrops","needExternal":true,"slots":{},"confidence":0.85}

Input: "Best kid-friendly things in SF for late Aug?"
Output: {"intent":"attractions","needExternal":false,"slots":{"city":"San Francisco","month":"August","dates":"late August","travelerProfile":"family with kids"},"confidence":0.80}

Input: "Flights to Paris next weekend under $600?"
Output: {"intent":"flights","needExternal":true,"slots":{"destinationCity":"Paris","dates":"next weekend"},"confidence":0.85}

Input: "flights from telaviv to ny today"
Output: {"intent":"flights","needExternal":true,"slots":{"originCity":"Tel Aviv","destinationCity":"New York City","dates":"today"},"confidence":0.90}

Input: "Flights to Moscow from Tel Aviv today"
Output: {"intent":"flights","needExternal":true,"slots":{"originCity":"Tel Aviv","destinationCity":"Moscow","dates":"today"},"confidence":0.95}

Input: "Do I need a visa for Japan?"
Output: {"intent":"policy","needExternal":true,"slots":{"city":"Japan"},"confidence":0.90}

Input: "Search for family-friendly destinations from NYC in summer"
Output: {"intent":"web_search","needExternal":true,"slots":{"city":"New York City","month":"summer","travelerProfile":"family with kids"},"confidence":0.85}

Input: "What can you help me with?"
Output: {"intent":"system","needExternal":false,"slots":{},"confidence":0.90}

Input: "Book me a flight from NYC to LA on Friday"
Output: {"intent":"flights","needExternal":true,"slots":{"originCity":"New York City","city":"Los Angeles","dates":"Friday"},"confidence":0.90}

Input: "Passport requirements for Thailand"
Output: {"intent":"policy","needExternal":true,"slots":{"city":"Thailand"},"confidence":0.90}

Input: "Where to go from Tel Aviv in August?"
Output: {"intent":"destinations","needExternal":true,"slots":{"city":"Tel Aviv","month":"August","dates":"August"},"confidence":0.85}

Input: "Going to LA 10/12–10/15 for a conference—what should I bring?"
Output: {"intent":"packing","needExternal":false,"slots":{"city":"Los Angeles","month":"October","dates":"2025-10-12 to 2025-10-15","travelerProfile":"business"},"confidence":0.85}

Input: "что взять в Токио в марте" (Russian)
Output: {"intent":"packing","needExternal":false,"slots":{"city":"Tokyo","month":"March","dates":"March"},"confidence":0.80}

Input: "is it hot?" (ambiguous)
Output: {"intent":"unknown","needExternal":false,"slots":{},"confidence":0.30}

Input: "Quel temps fait-il à Paris?" (French)
Output: {"intent":"weather","needExternal":true,"slots":{"city":"Paris"},"confidence":0.85}

Input: "Qué hacer en Madrid?" (Spanish)
Output: {"intent":"attractions","needExternal":false,"slots":{"city":"Madrid"},"confidence":0.80}

Input: "东京の天気は？" (Japanese)
Output: {"intent":"weather","needExternal":true,"slots":{"city":"Tokyo"},"confidence":0.85}

Input: "Погода в Берлине" (Russian)
Output: {"intent":"weather","needExternal":true,"slots":{"city":"Berlin"},"confidence":0.85}

Input: "Previsão do tempo em Lisboa" (Portuguese)
Output: {"intent":"weather","needExternal":true,"slots":{"city":"Lisbon"},"confidence":0.80}
Input: "Best hotels in Bangkok right now"
Output: {"intent":"web_search","needExternal":true,"slots":{"city":"Bangkok","dates":"today"},"confidence":0.90}

Input: "What are the change fees for JetBlue flights? Get me the official policy with receipts."
Output: {"intent":"policy","needExternal":true,"slots":{"city":"JetBlue"},"confidence":0.92}

Input: "My flight DL8718 from CDG to LHR was cancelled, please help me rebook"
Output: {"intent":"irrops","needExternal":true,"slots":{"originCity":"Paris","destinationCity":"London","dates":"today"},"confidence":0.93}
