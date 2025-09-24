import { getAmadeusClient } from '../vendors/amadeus_client.js';
import { withPolicies } from './_sdk_policies.js';
import { toStdError } from './errors.js';
// Removed micro-prompt parsers; date and IATA resolution handled via
// deterministic logic and Amadeus reference endpoints.

const IATA_REGEX = /^[A-Z]{3}$/;

const iataCache = new Map<string, string>();

const MONTHS = new Map<string, number>([
  ['january', 0],
  ['february', 1],
  ['march', 2],
  ['april', 3],
  ['may', 4],
  ['june', 5],
  ['july', 6],
  ['august', 7],
  ['september', 8],
  ['october', 9],
  ['november', 10],
  ['december', 11],
]);

function formatIso(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

function buildIso(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return formatIso(date);
}

function parseRelative(keyword: string, base: Date): string | null {
  const lower = keyword.trim().toLowerCase();
  if (!lower) return null;
  if (lower === 'today' || lower === 'tonight') return formatIso(base);
  if (lower === 'tomorrow') {
    const next = new Date(base);
    next.setDate(base.getDate() + 1);
    return formatIso(next);
  }
  if (lower === 'next week') {
    const next = new Date(base);
    next.setDate(base.getDate() + 7);
    return formatIso(next);
  }
  if (lower === 'next month') {
    const next = new Date(base);
    next.setMonth(base.getMonth() + 1, 1);
    return formatIso(next);
  }
  return null;
}

function splitCandidates(input: string): string[] {
  return input
    .replace(/[–—]/g, '-')
    .split(/(?:\bto\b|\bthrough\b|\-|\u2013|\u2014)/gi)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tryNumericDate(value: string): string | null {
  const match = value.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if (!match) return null;
  let year = Number(match[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const dmy = buildIso(year, second, first);
  if (dmy) return dmy;
  const mdy = buildIso(year, first, second);
  if (mdy) return mdy;
  return null;
}

function tryDateParse(value: string): string | null {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return formatIso(new Date(parsed));
}

function parseMonthOnly(token: string, base: Date): string | null {
  const lower = token.toLowerCase();
  const idx = MONTHS.get(lower);
  if (idx === undefined) return null;
  const year = base.getMonth() > idx ? base.getFullYear() + 1 : base.getFullYear();
  return formatIso(new Date(Date.UTC(year, idx, 1)));
}

function tryCandidate(candidate: string, base: Date): string | null {
  if (!candidate) return null;
  const relative = parseRelative(candidate, base);
  if (relative) return relative;
  const numeric = tryNumericDate(candidate);
  if (numeric) return numeric;
  const parsed = tryDateParse(candidate);
  if (parsed) return parsed;
  return parseMonthOnly(candidate, base);
}

export interface FlightSearchQuery {
  originLocationCode: string;
  destinationLocationCode: string;
  departureDate: string;
  adults: string;
  returnDate?: string;
  max?: string;
  nonStop?: boolean;
  currencyCode?: string;
}


async function ensureIataCode(
  value: string,
  type: 'origin' | 'destination',
): Promise<{ code: string | null; source: string }> {
  const trimmed = value.trim();
  if (!trimmed) return { code: null, source: 'empty' };

  const upper = trimmed.toUpperCase();
  if (IATA_REGEX.test(upper)) {
    return { code: upper, source: 'input' };
  }

  const cacheKey = `${type}:${upper}`;
  const cached = iataCache.get(cacheKey);
  if (cached) {
    return { code: cached, source: 'cache' };
  }

  try {
    const { resolveCity } = await import('./amadeus_locations.js');
    const resolved = await resolveCity(trimmed);
    if (resolved.ok && IATA_REGEX.test(resolved.cityCode)) {
      const code = resolved.cityCode.toUpperCase();
      iataCache.set(cacheKey, code);
      return { code, source: 'amadeus' };
    }
  } catch (error) {
    console.warn('⚠️ Amadeus city resolution failed', {
      type,
      value: trimmed,
      error: String(error),
    });
  }

  console.warn('⚠️ Unable to resolve location to IATA code', {
    type,
    value: trimmed,
  });
  return { code: null, source: 'unresolved' };
}

/**
 * Search flight offers using Amadeus SDK GET endpoint.
 */
export async function flightOffersGet(
  query: FlightSearchQuery,
  signal?: AbortSignal
): Promise<any> {
  try {
    console.log('🛫 Starting Amadeus flight search with query:', query);
    
    const result = await withPolicies(async () => {
      console.log('🔗 Getting Amadeus client...');
      const amadeus = await getAmadeusClient();
      
      const params = {
        originLocationCode: query.originLocationCode,
        destinationLocationCode: query.destinationLocationCode,
        departureDate: query.departureDate,
        adults: query.adults,
        ...(query.returnDate && { returnDate: query.returnDate }),
        ...(query.max && { max: query.max }),
        ...(query.nonStop !== undefined && { nonStop: query.nonStop }),
        ...(query.currencyCode && { currencyCode: query.currencyCode }),
      };
      
      console.log('📡 Making Amadeus API call with params:', params);
      const response = await amadeus.shopping.flightOffersSearch.get(params);
      console.log('✅ Amadeus API response received, data length:', response.data?.length || 0);
      if (!response.data || response.data.length === 0) {
        console.log('🔍 Empty response details:', {
          status: response.status,
          headers: response.headers,
          body: JSON.stringify(response.body || response, null, 2).slice(0, 1000)
        });
      }
      return { data: response.data, response };
    }, signal, Number(process.env.AMADEUS_API_TIMEOUT_MS || 45000));
    
    // Log successful result
    console.log('Amadeus flight search successful:', result?.data?.length || 0, 'offers');
    
    // Check for warnings in the response
    const responseBody = JSON.parse(result?.response?.body || '{}');
    const warnings = responseBody.warnings || [];
    
    // Return in expected format for graph
    if (result?.data && result.data.length > 0) {
      // Extract top 3 flight offers with details
      const topOffers = result.data.slice(0, 3).map((offer: any) => {
        const price = offer.price?.total;
        const currency = offer.price?.currency || 'EUR';
        const segments = offer.itineraries?.[0]?.segments || [];
        const firstSegment = segments[0];
        const lastSegment = segments[segments.length - 1];
        
        return {
          price: `${price} ${currency}`,
          departure: `${firstSegment?.departure?.iataCode} ${firstSegment?.departure?.at}`,
          arrival: `${lastSegment?.arrival?.iataCode} ${lastSegment?.arrival?.at}`,
          airline: firstSegment?.carrierCode,
          stops: segments.length > 1 ? `${segments.length - 1} stop(s)` : 'Direct'
        };
      });
      
      const summary = `Found ${result.data.length} flight offers from ${query.originLocationCode} to ${query.destinationLocationCode} on ${query.departureDate}

Top options:
${topOffers.map((offer: any, i: number) => 
  `${i + 1}. ${offer.price} - ${offer.departure} → ${offer.arrival} (${offer.airline}, ${offer.stops})`
).join('\n')}

${result.data.length > 3 ? `\n...and ${result.data.length - 3} more options available.` : ''}`;

      return {
        ok: true,
        source: 'amadeus',
        offers: result.data,
        count: result.data.length,
        summary
      };
    }
    
    // Handle case with warnings but no results
    if (warnings.length > 0) {
      const warningDetails = warnings.map((w: any) => w.detail).join('; ');
      return { 
        ok: false, 
        reason: 'incomplete_search',
        message: `Flight search incomplete: ${warningDetails}. This may be due to limited test data availability.`
      };
    }
    
    return { ok: false, reason: 'no_flights_found' };
    
  } catch (error) {
    console.error('Amadeus flight search failed:', error);
    const stdError = toStdError(error, 'flightOffersGet');
    
    // Fallback message if enabled and no results
    if (process.env.IATA_RESOLVER === 'llm' && stdError.code === 'not_found') {
      return {
        fallback: true,
        message: 'Flight search temporarily unavailable. Please try alternative airports or check directly with airlines.',
        source: 'llm_fallback',
      };
    }
    
    throw new Error(`${stdError.code}: ${stdError.message}`);
  }
}

/**
 * Search flight offers using Amadeus SDK POST endpoint.
 */
export async function flightOffersPost(
  body: unknown,
  signal?: AbortSignal
): Promise<any> {
  try {
    return await withPolicies(async () => {
      const amadeus = await getAmadeusClient();
      const response = await amadeus.shopping.flightOffersSearch.post(body);
      return response.data;
    }, signal, Number(process.env.AMADEUS_API_TIMEOUT_MS || 45000));
  } catch (error) {
    const stdError = toStdError(error, 'flightOffersPost');
    throw new Error(`${stdError.code}: ${stdError.message}`);
  }
}

/**
 * Price flight offers using Amadeus SDK.
 */
export async function flightOffersPrice(
  offer: unknown,
  include?: string,
  signal?: AbortSignal
): Promise<any> {
  try {
    return await withPolicies(async () => {
      const amadeus = await getAmadeusClient();
      
      const body = {
        data: {
          type: 'flight-offers-pricing',
          flightOffers: Array.isArray(offer) ? offer : [offer],
        },
        ...(include && { include }),
      };
      
      const response = await amadeus.shopping.flightOffers.pricing.post(body);
      return response.data;
    }, signal, Number(process.env.AMADEUS_API_TIMEOUT_MS || 45000));
  } catch (error) {
    const stdError = toStdError(error, 'flightOffersPrice');
    throw new Error(`${stdError.code}: ${stdError.message}`);
  }
}

/**
 * Get seatmaps from flight offer using Amadeus SDK.
 */
export async function seatmapsFromOffer(
  offer: unknown,
  signal?: AbortSignal
): Promise<any> {
  try {
    return await withPolicies(async () => {
      const amadeus = await getAmadeusClient();
      
      const body = {
        data: Array.isArray(offer) ? offer : [offer],
      };
      
      const response = await amadeus.shopping.seatmaps.post(body);
      return response.data;
    }, signal, Number(process.env.AMADEUS_API_TIMEOUT_MS || 45000));
  } catch (error) {
    const stdError = toStdError(error, 'seatmapsFromOffer');
    throw new Error(`${stdError.code}: ${stdError.message}`);
  }
}

// Legacy exports for backward compatibility
export async function searchFlights(params: {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults?: number;
  passengers?: number;
  cabinClass?: string;
}): Promise<any> {
  console.log('🔍 Starting flight search with params:', params);
  const originInput = params.origin?.trim() ?? '';
  const destinationInput = params.destination?.trim() ?? '';
  const departureInput = params.departureDate?.trim() ?? '';

  if (!originInput || !destinationInput || !departureInput) {
    return { ok: false, reason: 'missing_required_fields' };
  }

  const origin = await ensureIataCode(originInput, 'origin');
  if (!origin.code) {
    return { ok: false, reason: 'origin_unresolved' };
  }

  if (origin.source !== 'input') {
    console.log('📍 Origin resolved', {
      input: originInput,
      code: origin.code,
      source: origin.source,
    });
  }

  const destination = await ensureIataCode(destinationInput, 'destination');
  if (!destination.code) {
    return { ok: false, reason: 'destination_unresolved' };
  }

  if (destination.source !== 'input') {
    console.log('📍 Destination resolved', {
      input: destinationInput,
      code: destination.code,
      source: destination.source,
    });
  }

  const departureIso = await convertToAmadeusDate(departureInput);
  const returnIso = params.returnDate
    ? await convertToAmadeusDate(params.returnDate)
    : undefined;

  console.log('🛫 Final flight search', {
    origin: origin.code,
    destination: destination.code,
    departureDate: departureIso,
  });

  return flightOffersGet({
    originLocationCode: origin.code,
    destinationLocationCode: destination.code,
    departureDate: departureIso,
    adults: ((params.adults || params.passengers) || 1).toString(),
    ...(returnIso && { returnDate: returnIso }),
  });
}

export async function convertToAmadeusDate(dateStr?: string): Promise<string> {
  const base = new Date();
  const defaultIso = formatIso(base);
  if (!dateStr || !dateStr.trim()) return defaultIso;

  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const directRelative = parseRelative(trimmed, base);
  if (directRelative) return directRelative;

  const candidates = new Set<string>([trimmed]);

  // No LLM date extraction; rely on relative terms, numeric formats, and
  // native parsing as a last resort.

  for (const candidate of candidates) {
    for (const part of splitCandidates(candidate)) {
      const iso = tryCandidate(part, base);
      if (iso) return iso;
    }
    const fallback = tryCandidate(candidate, base);
    if (fallback) return fallback;
  }

  return defaultIso;
}

export interface SearchConstraints {
  origin: string;
  destination: string;
  departureDate: string;
  cabin?: string;
  passengers?: number;
}

export interface FlightAlternative {
  departure: string;
  arrival: string;
  carrier: string;
  flightNumber: string;
  price?: number;
}

/**
 * Search for alternative flights for IRROPS scenarios
 */
export async function searchAlternatives(
  originalSegments: any[],
  affectedSegmentIndex: number,
  constraints: SearchConstraints,
  signal?: AbortSignal
): Promise<FlightAlternative[]> {
  try {
    // Resolve city names to airport codes using Amadeus API
    const { resolveCity } = await import('./amadeus_locations.js');
    
    const originResolved = await resolveCity(constraints.origin);
    const destinationResolved = await resolveCity(constraints.destination);
    
    if (!originResolved.ok) {
      throw new Error(`Could not resolve origin city: ${constraints.origin}`);
    }
    
    if (!destinationResolved.ok) {
      throw new Error(`Could not resolve destination city: ${constraints.destination}`);
    }
    
    const result = await flightOffersGet({
      originLocationCode: originResolved.cityCode,
      destinationLocationCode: destinationResolved.cityCode,
      departureDate: constraints.departureDate,
      adults: (constraints.passengers || 1).toString(),
      max: '10'
    }, signal);

    // Handle the wrapped response format
    const offers = result.ok ? result.offers : [];
    if (!offers || offers.length === 0) return [];

    return offers.slice(0, 5).map((offer: any) => {
      const segment = offer.itineraries?.[0]?.segments?.[0];
      return {
        departure: segment?.departure?.at || constraints.departureDate + 'T08:00:00',
        arrival: segment?.arrival?.at || constraints.departureDate + 'T10:00:00',
        carrier: segment?.carrierCode || 'XX',
        flightNumber: (segment?.carrierCode || 'XX') + (segment?.number || '000'),
        price: parseFloat(offer.price?.total || '0')
      };
    });
  } catch (error) {
    console.error('Alternative search failed:', error);
    return [];
  }
}
