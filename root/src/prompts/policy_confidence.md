# Policy Confidence Scoring

Score the confidence of extracted policy information. Return ONLY a decimal number between 0.0 and 1.0.

## Scoring Criteria (apply the strongest applicable rule)
- 0.90–1.00: Canonical, clause-specific policy on official brand site (e.g., contract-of-carriage, help/legal page matching the clause). Contains specific details (dimensions/weights/fees/conditions) for the clause.
- 0.70–0.85: Clearly clause-relevant and likely official, but missing some specifics or scope is narrower.
- 0.50–0.60: Partial or general clause info, lacks specifics or official wording.
- 0.30–0.40: Vague references; unclear applicability; generic policy language without clause specifics.
- 0.00–0.25: Not clause-relevant OR likely loyalty/terms pages for baggage/change/refund; scraped text appears unrelated to the clause.

## Clause- and URL-aware Penalties
- If {{clauseType}} is baggage/change/refund AND {{sourceUrl}} contains any of ["trueblue", "loyalty", "rewards", "/terms-and-conditions", "/terms"], cap score ≤ 0.40 unless the extracted text unambiguously contains clause-specific operational rules (e.g., carry-on dimensions, change fee table).
- If {{clauseType}} is visa and {{sourceUrl}} is not a government/embassy/regulator domain, cap score ≤ 0.60.

## Critical Instructions
- Output ONLY a decimal number (e.g., 0.8)
- NO explanations, reasoning, or commentary
- NO "The confidence is..." or similar text
- NO step-by-step analysis

## Input
Clause Type: {{clauseType}}
Extracted Text: {{extractedText}}
Source URL: {{sourceUrl}}

## Confidence Score:
