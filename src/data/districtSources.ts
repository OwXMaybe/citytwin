/**
 * Where each city's district boundaries come from in OpenStreetMap.
 * `areaRelation` is the OSM relation of the city/province; districts are the
 * administrative boundaries of `adminLevel` inside it. Used by pipeline/import-districts.ts.
 */
export interface DistrictSource {
  cityId: string;
  areaRelation: number;
  adminLevel: number;
  label: string; // what the units are called locally
}

export const DISTRICT_SOURCES: DistrictSource[] = [
  { cityId: 'istanbul', areaRelation: 223474, adminLevel: 6, label: 'İlçe (district)' },
  { cityId: 'ankara', areaRelation: 223422, adminLevel: 6, label: 'İlçe (district)' },
  { cityId: 'izmir', areaRelation: 223167, adminLevel: 6, label: 'İlçe (district)' },
  { cityId: 'tekirdag', areaRelation: 223470, adminLevel: 6, label: 'İlçe (district)' },
  { cityId: 'edirne', areaRelation: 223465, adminLevel: 6, label: 'İlçe (district)' },
  { cityId: 'bursa', areaRelation: 223463, adminLevel: 6, label: 'İlçe (district)' },
  { cityId: 'kocaeli', areaRelation: 223473, adminLevel: 6, label: 'İlçe (district)' },
  { cityId: 'antalya', areaRelation: 223132, adminLevel: 6, label: 'İlçe (district)' },
  { cityId: 'berlin', areaRelation: 62422, adminLevel: 9, label: 'Bezirk (borough)' },
  { cityId: 'london', areaRelation: 175342, adminLevel: 8, label: 'London borough' },
  { cityId: 'newyork', areaRelation: 175905, adminLevel: 7, label: 'Borough' },
];
