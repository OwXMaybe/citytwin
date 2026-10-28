import type { City } from '../types/data';

export const CITIES: City[] = [
  { id: 'istanbul', name: 'Istanbul', country: 'Türkiye', lat: 41.0369, lon: 28.985, zoom: 14.6, timezone: 'Europe/Istanbul' },
  { id: 'ankara', name: 'Ankara', country: 'Türkiye', lat: 39.9208, lon: 32.8541, zoom: 14.6, timezone: 'Europe/Istanbul' },
  { id: 'izmir', name: 'İzmir', country: 'Türkiye', lat: 38.4237, lon: 27.1428, zoom: 14.6, timezone: 'Europe/Istanbul' },
  { id: 'tekirdag', name: 'Tekirdağ', country: 'Türkiye', lat: 40.9781, lon: 27.5117, zoom: 14.6, timezone: 'Europe/Istanbul' },
  { id: 'edirne', name: 'Edirne', country: 'Türkiye', lat: 41.6764, lon: 26.5557, zoom: 14.6, timezone: 'Europe/Istanbul' },
  { id: 'bursa', name: 'Bursa', country: 'Türkiye', lat: 40.1828, lon: 29.067, zoom: 14.6, timezone: 'Europe/Istanbul' },
  { id: 'kocaeli', name: 'Kocaeli', country: 'Türkiye', lat: 40.7656, lon: 29.9406, zoom: 14.6, timezone: 'Europe/Istanbul' },
  { id: 'antalya', name: 'Antalya', country: 'Türkiye', lat: 36.8848, lon: 30.704, zoom: 14.6, timezone: 'Europe/Istanbul' },
  { id: 'berlin', name: 'Berlin', country: 'Germany', lat: 52.5163, lon: 13.3777, zoom: 14.6, timezone: 'Europe/Berlin' },
  { id: 'london', name: 'London', country: 'United Kingdom', lat: 51.5098, lon: -0.118, zoom: 14.6, timezone: 'Europe/London' },
  { id: 'newyork', name: 'New York', country: 'United States', lat: 40.7549, lon: -73.984, zoom: 14.6, timezone: 'America/New_York' },
];

export const DEFAULT_CITY = CITIES[0];

/** Analysis grid: hexagonal zones around the city centre. */
export const GRID = { rings: 2, hexRadiusKm: 1.2 };
