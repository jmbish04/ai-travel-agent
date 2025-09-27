import { getAmadeusClient } from '../vendors/amadeus_client.js';
import { withPolicies } from './_sdk_policies.js';
import { toStdError } from './errors.js';

export interface HotelSearchQuery {
  cityCode?: string;
  latitude?: number;
  longitude?: number;
  radius?: number;
  radiusUnit?: 'KM' | 'MILE';
  chainCodes?: string;
  amenities?: string[];
  ratings?: string[];
  hotelSource?: string;
}

export interface HotelOffersQuery extends HotelSearchQuery {
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  roomQuantity?: number;
  priceRange?: string;
  currency?: string;
  paymentPolicy?: string;
  boardType?: string;
}

/**
 * Search hotel offers using Amadeus SDK.
 */
export async function hotelOffersSearch(
  query: HotelOffersQuery,
  signal?: AbortSignal
): Promise<any> {
  try {
    return await withPolicies(async () => {
      const amadeus = await getAmadeusClient();
      // Normalize dates (support relative keywords) using shared converter
      const { convertToAmadeusDate } = await import('./amadeus_flights.js');
      let checkInIso = await convertToAmadeusDate(query.checkInDate);
      let checkOutIso = await convertToAmadeusDate(query.checkOutDate);
      // If planner supplied a past date, bump to next week by default
      const todayIso = new Date().toISOString().split('T')[0]!;
      if (checkInIso < todayIso) {
        checkInIso = await convertToAmadeusDate('next week');
      }
      // Ensure at least 2 nights when dates collapse to same day
      if (checkOutIso <= checkInIso) {
        const d = new Date(checkInIso);
        d.setUTCDate(d.getUTCDate() + 2);
        checkOutIso = d.toISOString().split('T')[0]!;
      }

      const params: Record<string, unknown> = {
        checkInDate: checkInIso,
        checkOutDate: checkOutIso,
        adults: String(query.adults),
        ...(query.cityCode && { cityCode: query.cityCode }),
        ...(query.latitude && query.longitude && {
          latitude: query.latitude,
          longitude: query.longitude,
        }),
        ...(query.radius && { radius: query.radius }),
        ...(query.radiusUnit && { radiusUnit: query.radiusUnit }),
        ...(query.chainCodes && { chainCodes: query.chainCodes }),
        ...(query.amenities && { amenities: query.amenities }),
        ...(query.ratings && { ratings: query.ratings }),
        ...(query.roomQuantity && { roomQuantity: query.roomQuantity }),
        ...(query.priceRange && { priceRange: query.priceRange }),
        ...(query.currency && { currency: query.currency }),
        ...(query.paymentPolicy && { paymentPolicy: query.paymentPolicy }),
        ...(query.boardType && { boardType: query.boardType }),
        ...(query.hotelSource && { hotelSource: query.hotelSource }),
      };
      
      try {
        const response = await amadeus.shopping.hotelOffersSearch.get(params);
        const data = response?.data ?? response?.result?.data ?? [];
        if (Array.isArray(data) && data.length > 0) return data;
      } catch (err) {
        // Fall through to byCity → hotelIds fallback
        const e: any = err as any;
        if (process.env.LOG_LEVEL === 'debug') {
          console.debug('Hotel offers by city failed; attempting hotelIds fallback', { status: e?.response?.status, body: e?.response?.result || e?.response?.body });
        }
      }

      // Fallback: enumerate hotels in city then query offers by hotelIds
      if (query.cityCode) {
        const list = await amadeus.referenceData.locations.hotels.byCity.get({ cityCode: query.cityCode });
        const hotels = Array.isArray(list?.data) ? list.data : [];
        const ids = hotels.map((h: any) => h?.hotelId).filter(Boolean).slice(0, 20);
        if (ids.length > 0) {
          const resp2 = await amadeus.shopping.hotelOffersSearch.get({
            hotelIds: ids.join(','),
            checkInDate: checkInIso,
            checkOutDate: checkOutIso,
            adults: String(query.adults),
            ...(query.roomQuantity ? { roomQuantity: String(query.roomQuantity) } : {}),
          });
          return resp2?.data ?? resp2?.result?.data ?? [];
        }
      }
      return [];
    }, signal, 8000);
  } catch (error) {
    const stdError = toStdError(error, 'hotelOffersSearch');
    // Attach extra details for easier debugging in debug mode
    if (process.env.LOG_LEVEL === 'debug') {
      try {
        const resp: any = (error as any)?.response;
        console.debug('hotelOffersSearch error details', { status: resp?.status, body: resp?.result || resp?.body });
      } catch {}
    }
    throw new Error(`${stdError.code}: ${stdError.message}`);
  }
}

/**
 * Search hotels by city using reference data.
 */
export async function searchHotelsByCity(
  cityCode: string,
  signal?: AbortSignal
): Promise<any> {
  try {
    return await withPolicies(async () => {
      const amadeus = await getAmadeusClient();
      
      const response = await amadeus.referenceData.locations.hotels.byCity.get({
        cityCode,
      });
      
      return response.data;
    }, signal, 4000);
  } catch (error) {
    const stdError = toStdError(error, 'searchHotelsByCity');
    throw new Error(`${stdError.code}: ${stdError.message}`);
  }
}

/**
 * Get hotel details by hotel ID.
 */
export async function getHotelById(
  hotelId: string,
  signal?: AbortSignal
): Promise<any> {
  try {
    return await withPolicies(async () => {
      const amadeus = await getAmadeusClient();
      
      const response = await amadeus.referenceData.locations.hotels.byHotels.get({
        hotelIds: hotelId,
      });
      
      return response.data;
    }, signal, 4000);
  } catch (error) {
    const stdError = toStdError(error, 'getHotelById');
    throw new Error(`${stdError.code}: ${stdError.message}`);
  }
}
