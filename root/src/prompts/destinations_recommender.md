Based on the following travel preferences, recommend 3-4 destinations.

Preferences: {preferences}
User query context: {slots}

Return ONLY a valid JSON array with no additional text or explanation. Each destination should include a brief reason why it matches the preferences.

Required JSON structure:
[
  {
    "city": "City Name",
    "country": "Country Name", 
    "description": "Why this destination is a good fit.",
    "tags": {
      "climate": "warm|cold|temperate",
      "budget": "low|mid|high",
      "family_friendly": true|false
    }
  }
]

Return only the JSON array, no other text.
