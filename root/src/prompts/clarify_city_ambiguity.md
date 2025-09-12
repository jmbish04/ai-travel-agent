# City Ambiguity Resolution

Multiple cities match your request. To provide accurate flight information, I need you to specify which city you intended.

## Available Options
{{#candidates}}
- **{{cityName}}** ({{cityCode}}) - Confidence: {{confidence}}
{{/candidates}}

## Resolution Instructions
Please provide ANY of the following to help identify the correct city:
1. The country or region you're referring to
2. Any nearby airports or landmarks
3. Simply choose from the numbered options above

## Communication Guidelines
- Be concise and direct about the ambiguity
- Present options clearly with confidence scores
- Provide multiple ways to resolve the ambiguity
- Do not guess or assume without explicit user confirmation

## Example Response
"I found multiple cities that could match your request. Please help me identify which one you meant:

1. **New York City** (JFK) - Confidence: 0.85
2. **Newark** (EWR) - Confidence: 0.65
3. **Newcastle** (NCL) - Confidence: 0.45

To help me find the exact flights you're looking for, please:
- Specify the country (e.g., USA, UK)
- Mention any nearby airports or landmarks
- Or simply choose the number of your intended city

This will ensure I provide accurate flight information for your intended destination."
