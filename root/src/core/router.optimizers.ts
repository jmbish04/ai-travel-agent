// Router optimization utilities - regex guards and heuristics

export const RE = {
  flightDirect: /\b(from|ex)\s+[\w\s.'-]+?\s+(to|→|-?>)\s+[\w\s.'-]+/i,
  iataPair: /\b([A-Z]{3})\s*(to|→|-?>)\s*([A-Z]{3})\b/,
  dateish: /\b(today|tomorrow|this (week|weekend|month)|next (week|month)|\d{1,2}[-/]\d{1,2}([-/]\d{2,4})?)\b/i,
  flights: /\b(flight|flights|book|booking|airline|fare|one way|round ?trip)\b/i,
  weather: /\b(weather|temperature|forecast|precip)\b/i,
};

export function isDirectFlightHeuristic(msg: string): {isDirect: boolean; reason: string} {
  const m = msg.trim();
  const direct = (RE.flightDirect.test(m) || RE.iataPair.test(m)) && RE.dateish.test(m);
  return { isDirect: direct, reason: direct ? 'od+date' : 'missing_od_or_date' };
}
