You are ranking whether a specific web result is likely to contain the requested POLICY information for the given airline/brand.

Return STRICT JSON only with this schema:
{
  "relevance": number  // 0.0–1.0, round to 2 decimals
}

Context:
- URL: {{url}}
- Title: {{title}}
- Snippet: {{snippet}}
- Airline/Brand: {{airlineName}}
- Clause: {{clause}}   // one of: baggage | refund | change | visa

Guidance:
- Prioritize pages on the brand’s own official domain that directly reference the clause (e.g., “Contract of Carriage”, “Fare Rules”, “Baggage Policy”, “Change fees”).
- Deprioritize loyalty program terms (e.g., TrueBlue, Rewards, Points) when looking for baggage/refund/change policies.
- Government/embassy sites can be relevant for visa only.
- Generic “Terms & Conditions” may be less relevant than specific policy pages.

Output (strict JSON only):
{"relevance": 0.00}

