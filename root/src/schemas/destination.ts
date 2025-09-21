
import { z } from 'zod';

export const CountrySchema = z.object({
  name: z.object({ common: z.string() }),
  capital: z.array(z.string()).optional(),
  region: z.string(),
  subregion: z.string().optional(),
  languages: z.record(z.string()).optional(),
  currencies: z.record(z.object({ name: z.string(), symbol: z.string() })).optional(),
  population: z.number(),
});

export const OpenTripMapFeatureSchema = z.object({
  type: z.string(),
  id: z.string(),
  geometry: z.object({
    type: z.string(),
    coordinates: z.array(z.number()),
  }),
  properties: z.object({
    xid: z.string(),
    name: z.string(),
    dist: z.number(),
    rate: z.number(),
    osm: z.string().optional(),
    wikidata: z.string().optional(),
    kinds: z.string(),
  }),
});

export const WeatherSchema = z.object({
  coord: z.object({
    lon: z.number(),
    lat: z.number(),
  }),
  weather: z.array(
    z.object({
      id: z.number(),
      main: z.string(),
      description: z.string(),
      icon: z.string(),
    })
  ),
  base: z.string(),
  main: z.object({
    temp: z.number(),
    feels_like: z.number(),
    temp_min: z.number(),
    temp_max: z.number(),
    pressure: z.number(),
    humidity: z.number(),
  }),
  visibility: z.number(),
  wind: z.object({
    speed: z.number(),
    deg: z.number(),
  }),
  clouds: z.object({
    all: z.number(),
  }),
  dt: z.number(),
  sys: z.object({
    type: z.number(),
    id: z.number(),
    country: z.string(),
    sunrise: z.number(),
    sunset: z.number(),
  }),
  timezone: z.number(),
  id: z.number(),
  name: z.string(),
  cod: z.number(),
});
