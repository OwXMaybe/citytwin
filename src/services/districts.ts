import type { DistrictCollection, Provenance } from '../types/data';
import { getBackend } from './backend';

export const DISTRICT_PROVENANCE: Provenance = {
  source: 'external-api',
  provider: 'OpenStreetMap administrative boundaries',
  note: 'Imported via Overpass by pipeline/import-districts.ts and simplified to ~25 m. Served from PostGIS when the backend runs. Population only where OSM tags it.',
};

/**
 * Loads district boundaries: from PostGIS via the backend when available (areas and
 * centroids computed by the database), otherwise from the pipeline's static files.
 * Returns null (→ synthetic hex grid fallback) when no import exists for the city.
 */
export async function fetchDistricts(cityId: string, signal?: AbortSignal): Promise<DistrictCollection | null> {
  if (await getBackend()) {
    const res = await fetch(`/api/v1/cities/${cityId}/districts`, { signal });
    if (res.ok) return (await res.json()) as DistrictCollection;
    // 404 = not loaded into the database yet → fall through to the static file.
  }
  const res = await fetch(`${import.meta.env.BASE_URL}data/districts/${cityId}.geojson`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`District boundaries unavailable (${res.status})`);
  const text = await res.text();
  // Dev servers answer unknown paths with index.html — treat as "not imported".
  if (!text.trimStart().startsWith('{')) return null;
  return JSON.parse(text) as DistrictCollection;
}
