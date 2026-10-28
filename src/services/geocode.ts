/**
 * Place search via Photon (komoot), an OpenStreetMap-based geocoder with CORS support.
 * https://photon.komoot.io — fair-use public instance; Phase 4 proxies this via the backend.
 */

export interface PlaceResult {
  id: string;
  label: string;
  detail: string;
  lon: number;
  lat: number;
  extent?: [number, number, number, number]; // minLon, maxLat, maxLon, minLat (Photon order)
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_id: number;
    osm_type: string;
    name?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    country?: string;
    type?: string;
    extent?: [number, number, number, number];
  };
}

export async function searchPlaces(query: string, near?: { lon: number; lat: number }, signal?: AbortSignal): Promise<PlaceResult[]> {
  const params = new URLSearchParams({ q: query, limit: '6' });
  if (near) {
    params.set('lon', String(near.lon));
    params.set('lat', String(near.lat));
  }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = (await res.json()) as { features: PhotonFeature[] };
  return data.features.map((f) => {
    const p = f.properties;
    const detail = [p.district, p.city, p.state, p.country].filter((x) => x && x !== p.name).join(', ');
    return {
      id: `${p.osm_type}${p.osm_id}`,
      label: p.name ?? detail ?? 'Unnamed place',
      detail: [p.type, detail].filter(Boolean).join(' · '),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      extent: p.extent,
    };
  });
}
