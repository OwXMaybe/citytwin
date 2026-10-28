import { elementsToImport, type OsmImport } from './buildings';
import { cacheGet, cacheSet } from './cache';
import { getBackend } from '../backend';
import { runOverpass, type OverpassResult } from './overpass';
import { locale } from '../../i18n';

/** Largest area the browser will request from public Overpass in one go. */
export const MAX_IMPORT_KM2 = 4;
const CACHE_TTL = 7 * 86400_000;
const INDEX_KEY = 'view-index';

export type BBox = [number, number, number, number]; // w, s, e, n

export function bboxAreaKm2([w, s, e, n]: BBox) {
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  return (e - w) * 111.32 * Math.cos(midLat) * (n - s) * 110.574;
}

/** Snap to a ~100 m grid so small pans reuse the same cache entry. */
const snap = (b: BBox): BBox => [Math.floor(b[0] * 1000) / 1000, Math.floor(b[1] * 1000) / 1000, Math.ceil(b[2] * 1000) / 1000, Math.ceil(b[3] * 1000) / 1000];

/** Accept a cached area if it covers the request within ~100 m on every side. */
const covers = (c: BBox, r: BBox, tol = 0.001) => c[0] <= r[0] + tol && c[1] <= r[1] + tol && c[2] >= r[2] - tol && c[3] >= r[3] - tol;

const keyOf = (b: BBox) => `view:${b.join(',')}`;

/** Backend mode: mirror fallback + shared 7-day PostGIS cache live server-side. */
async function overpassViaBackend(query: string, opts: { signal?: AbortSignal; onStatus?: (s: string) => void }): Promise<OverpassResult> {
  opts.onStatus?.('Querying Overpass via CityTwin backend (shared cache)…');
  const res = await fetch('/api/v1/overpass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: opts.signal ?? AbortSignal.timeout(6 * 60_000),
  });
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail;
    throw new Error(detail ?? `Backend Overpass request failed (${res.status})`);
  }
  const json = (await res.json()) as { elements: OverpassResult['elements']; osm3s?: { timestamp_osm_base?: string } };
  const host = res.headers.get('X-Overpass-Endpoint') || 'overpass';
  const cached = res.headers.get('X-Cache') === 'HIT';
  return { elements: json.elements, endpoint: `https://${host}${cached ? '/cached' : ''}`, timestamp: json.osm3s?.timestamp_osm_base ?? null };
}

export async function importView(
  bbox: BBox,
  opts: { signal?: AbortSignal; onStatus?: (s: string) => void; force?: boolean } = {},
): Promise<OsmImport & { fromCache: boolean }> {
  const b = snap(bbox);
  const area = bboxAreaKm2(b);
  if (area > MAX_IMPORT_KM2) throw new Error(`View covers ${area.toFixed(1)} km²; zoom in to under ${MAX_IMPORT_KM2} km² to import building attributes.`);

  const index = (await cacheGet<BBox[]>(INDEX_KEY, CACHE_TTL)) ?? [];
  if (!opts.force) {
    for (const cached of index.filter((c) => covers(c, b))) {
      const hit = await cacheGet<OsmImport>(keyOf(cached), CACHE_TTL);
      if (hit) return { ...hit, fromCache: true };
    }
  }

  const bb = `${b[1]},${b[0]},${b[3]},${b[2]}`; // s,w,n,e
  const query = `[out:json][timeout:40];
(
  way["building"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  node["natural"="tree"](${bb});
);
out geom;`;
  const res = (await getBackend())
    ? await overpassViaBackend(query, opts)
    : await runOverpass(query, {
        signal: opts.signal,
        timeoutMs: 45_000,
        onAttempt: (ep, n) => opts.onStatus?.(`Querying ${new URL(ep).host} (attempt ${n})…`),
      });
  opts.onStatus?.(`Parsing ${res.elements.length.toLocaleString(locale())} OSM elements…`);
  const result = elementsToImport(res.elements, { source: `Overpass (${new URL(res.endpoint).host})`, osmTimestamp: res.timestamp, bbox: b });
  await cacheSet(keyOf(b), result);
  await cacheSet(INDEX_KEY, [b, ...index.filter((c) => keyOf(c) !== keyOf(b))].slice(0, 50));
  return { ...result, fromCache: false };
}
