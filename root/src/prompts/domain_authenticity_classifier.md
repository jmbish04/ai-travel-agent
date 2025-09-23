You are scoring whether a domain is an official and authoritative source for a given subject.

Subject: "{{airlineName}}" (this may be a country/region/agency OR a brand like an airline/hotel)
Domain to score: "{{domain}}"

General rule:
- Return a single number 0.0–1.0 indicating how official/authoritative this domain is for this subject. Higher = more official.

Heuristics to apply (do not explain, just score):
- Government and regulators (country/visa/health/travel restrictions):
  - Very high (0.90–1.0): official government/regulator domains: *.gov, *.gov.xx, *.go.xx, *.gouv.fr, *.gov.uk, *.europa.eu, *.state.gov, *.cdc.gov, *.transportation.gov, *.homeaffairs.gov.au, *.immigration.gov.xx, usembassy.gov subdomains.
  - Medium (0.60–0.85): supranational or standard bodies (e.g., iata.org, icao.int, ecdc.europa.eu) — authoritative but not government policy for a specific country.
  - Low (≤0.40): news, blogs, aggregators (schengenvisainfo.com, travel blogs), booking sites.
- Airlines and hotels (brand policies like baggage, fare rules, cancellation):
  - Very high (0.90–1.0): the brand’s official domain or subdomain (e.g., delta.com, united.com, marriott.com, hilton.com).
  - Low (≤0.40): third-party booking (expedia.com), reviews (seatguru.com), blogs, forums, general media.
- Embassies/consulates (visa/entry rules):
  - Very high (0.90–1.0): official embassy/consulate domains (e.g., fr.usembassy.gov, uk.embassy.gov.xx).

Important disambiguation (strict):
- If the subject is a country/region/agency (e.g., "USA", "United Kingdom", "France", "CDC", "Home Office"), ONLY government/regulator/embassy domains are official (≥0.90). Airline/hotel brand domains are NOT official for such subjects (≤0.10). Booking/aggregators/blogs are NOT official (≤0.40).
- If the subject is an airline/hotel brand, ONLY that brand’s official domain/subdomain should be very high (≥0.90). Government domains are not “official” for a brand’s own policy (≤0.40), unless the subject itself is the regulator.

Examples (return just the number):
- elal.com for El Al → 0.95 (official)
- upgradedpoints.com for El Al → 0.20 (third‑party)
- expedia.com for Delta → 0.15 (booking site)
- travel.state.gov for USA → 0.98 (official government)
- cdc.gov for USA travel health → 0.98 (official regulator)
- iata.org for USA entry rules → 0.70 (authoritative industry, but not government policy)
- united.com for USA → 0.05 (airline brand, not official for country policy)
- delta.com for USA → 0.05 (airline brand, not official for country policy)
- travel.state.gov for USA → 0.98 (official government)
- cdc.gov for USA → 0.98 (official regulator)
- schengenvisainfo.com for EU visas → 0.30 (informative but unofficial)

Output: ONLY the numeric score 0.0–1.0
