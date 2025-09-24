Analyze this travel request and extract preferences. Output STRICT JSON only — no prose, no code fences, no extra fields.

Text:
"{text}"

Return exactly this JSON schema (use null when unclear; all strings lowercase):
{
  "travelStyle": "family|romantic|adventure|cultural|business|budget|luxury|null",
  "budgetLevel": "low|mid|high|null",
  "activityType": "museums|nature|nightlife|shopping|food|history|null",
  "groupType": "solo|couple|family|friends|business|null",
  "theme": "coastal|mountain|city|island|any",
  "confidence": 0.00-1.00
}

Guidance:
- Map obvious phrases to theme (soft):
  - coastal: coast|coastal|beach|seaside|island|oceanfront
  - mountain: mountain|alps|himalaya|peaks|hiking trip
  - city: city break|urban|metropolis
  - island: island hopping|islands
- If no theme is implied, set theme="any".
- Round confidence to 2 decimals. Confidence reflects overall extraction certainty.
