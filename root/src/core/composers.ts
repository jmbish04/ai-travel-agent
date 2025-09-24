export function composeWeatherReply(city?: string, when?: string, summary?: string, source = 'Open-Meteo'): string {
  const ctx = [city, when].filter(Boolean).join(' — ');
  return ctx ? `Weather for ${ctx}: ${summary} (${source})` : `Weather: ${summary} (${source})`;
}

export function composePackingReply(
  city?: string,
  when?: string,
  summary?: string,
  items: string[] = [],
  source?: string,
): string {
  const heading = [city, when].filter(Boolean).join(' — ');
  const weatherLine = summary ? `Weather: ${summary}${source ? ` (${source})` : ''}` : '';

  const lines: string[] = [];
  if (heading && weatherLine) {
    lines.push(`${heading}: ${weatherLine}`);
  } else if (heading) {
    lines.push(heading);
  } else if (weatherLine) {
    lines.push(weatherLine);
  }

  if (items.length > 0) {
    lines.push(`Pack: ${items.join(', ')}`);
  }

  return lines.join('\n').trim();
}

export function composeAttractionsReply(city: string, attractions: string[], source = 'OpenTripMap'): string {
  const bullets = attractions.map(item => `• ${item}`).join('\n');
  return `${bullets} (${source})`;
}
