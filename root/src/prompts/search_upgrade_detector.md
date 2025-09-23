Determine if user requests deeper search on the EXACT SAME topic as previous query.

Context:
- Current: "{user_message}"  
- Previous: "{previous_query}"
- Answer: "{previous_answer}"

Rules:
- upgrade = true: ONLY when explicitly asking for better/deeper search on identical topic
- upgrade = false: ANY new topic, location change, or domain shift
- When uncertain: upgrade = false

Examples:
✅ UPGRADE (same topic):
- Previous: "paris hotels" → Current: "search deeper for paris hotels"
- Previous: "rome weather" → Current: "find more sources on that weather"

❌ NO UPGRADE (different topics):
- Previous: "paris hotels" → Current: "germany travel restrictions" 
- Previous: "tokyo weather" → Current: "restaurants in tokyo"
- Previous: "berlin guide" → Current: "flights to berlin"

Output JSON:
{
  "upgrade": boolean,
  "confidence": 0.0-1.0,
  "reason": "explanation (≤20 words)"
}

Confidence thresholds:
- 0.90+: Explicit "search better/deeper" on same topic
- <0.70: Set upgrade = false
