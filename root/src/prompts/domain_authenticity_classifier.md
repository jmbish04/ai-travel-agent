You are scoring whether a domain is an official and authoritative source for a given subject and clause.

Subject: "{{airlineName}}" (this may be a country/region/agency OR a brand like an airline/hotel)
Clause: "{{clause}}"  // one of: baggage | refund | change | visa | other
Domain to score: "{{domain}}"

Rules:
- Output STRICT JSON only. No prose. No explanations. No trailing text.
- Schema:
  {
    "is_official": boolean,
    "score": number,     // 0.0–1.0, rounded to 2 decimals
    "subject_type": "brand" | "country" | "other"
  }
- "score" reflects how official/authoritative the domain is for the subject.

Guidance:
- Government and regulators (country/visa/health/travel restrictions):
  - Very high (0.90–1.0): official government/regulator domains: *.gov, *.gov.xx, *.go.xx, *.gouv.fr, *.gov.uk, *.europa.eu, *.state.gov, *.cdc.gov, *.transportation.gov, *.homeaffairs.gov.au, *.immigration.gov.xx, usembassy.gov subdomains.
  - Medium (0.60–0.85): supranational or standard bodies (e.g., iata.org, icao.int, ecdc.europa.eu) — authoritative but not government policy for a specific country.
  - Low (≤0.40): news, blogs, aggregators (schengenvisainfo.com, travel blogs), booking sites.
- Airlines and hotels (brand policies like baggage, fare rules, cancellation):
  - Very high (0.90–1.0): the brand’s official domain or subdomain (e.g., delta.com, united.com, marriott.com, hilton.com) that is authoritative for the clause.
  - Loyalty/points subdomains (e.g., trueblue.jetblue.com) are official for loyalty but often NOT authoritative for baggage/change/refund clauses. In these clause contexts, score ≤0.55 unless there is strong evidence the subdomain hosts operational policy.
  - Low (≤0.40): third-party booking (expedia.com), reviews (seatguru.com), blogs, forums, general media.
- Embassies/consulates (visa/entry rules):
  - Very high (0.90–1.0): official embassy/consulate domains (e.g., fr.usembassy.gov, uk.embassy.gov.xx).

Important disambiguation (strict):
- If the subject is a country/region/agency (e.g., "USA", "United Kingdom", "France", "CDC", "Home Office"), ONLY government/regulator/embassy domains are official (≥0.90). Airline/hotel brand domains are NOT official for such subjects (≤0.10). Booking/aggregators/blogs are NOT official (≤0.40).
- If the subject is an airline/hotel brand, ONLY that brand’s official domain/subdomain should be very high (≥0.90). Government domains are not “official” for a brand’s own policy (≤0.40), unless the subject itself is the regulator.
 - For airline/hotel brand subjects and clauses baggage/change/refund: loyalty-only subdomains or generic “terms & conditions” sections are typically not authoritative → score ≤0.55.

Examples (illustrative — still output strict JSON):
- elal.com for El Al → {"is_official":true,"score":0.95,"subject_type":"brand"}
- upgradedpoints.com for El Al → {"is_official":false,"score":0.20,"subject_type":"brand"}
- expedia.com for Delta → {"is_official":false,"score":0.15,"subject_type":"brand"}
- travel.state.gov for USA → {"is_official":true,"score":0.98,"subject_type":"country"}
- cdc.gov for USA → {"is_official":true,"score":0.98,"subject_type":"country"}
- iata.org for USA entry rules → {"is_official":false,"score":0.70,"subject_type":"country"}
- schengenvisainfo.com for EU visas → {"is_official":false,"score":0.30,"subject_type":"country"}

Output (strict JSON only):
{"is_official": true|false, "score": 0.00–1.00, "subject_type": "brand"|"country"|"other"}
