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
- Strongly prioritize pages on the brand’s own official domain that directly reference the clause (e.g., “Contract of Carriage”, “Fare Rules”, “Baggage Policy”, “Change fees”).
- For baggage/refund/change clauses, penalize loyalty program subdomains and pages (e.g., TrueBlue, Rewards, Points, Miles) and generic “Terms & Conditions” pages. These are often NOT the canonical operational policy sources.
- Government/embassy sites are relevant ONLY for visa.
- Prefer URLs and titles that include policy-specific tokens (examples):
  - baggage: carry-on, cabin, checked, baggage, allowance, size, weight
  - change: change, changes, fare rules, standby, modify, rebook
  - refund: refund, cancellations, cancel, risk-free
  - visa: visa, entry requirements, immigration, consulate, embassy
- If URL or title indicates loyalty program or generic terms (e.g., contains “trueblue”, “loyalty”, “rewards”, “/terms-and-conditions”), cap relevance ≤ 0.35 for baggage/change/refund.
- If URL or title indicates “contract-of-carriage” or a help/legal/policy section that matches the clause, score ≥ 0.7 when plausible.

Output (strict JSON only):
{"relevance": 0.00}
