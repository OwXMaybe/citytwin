/**
 * OSM → GeoJSON geometry core. Shared by the browser import pipeline and the
 * Node import scripts in /pipeline, so it uses explicit `.ts` import paths and
 * only type-erasable TypeScript (runs under `node` without a build step).
 */

export type LonLat = [number, number];

export interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
export interface OverpassWay {
  type: 'way';
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}
export interface OverpassRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}
export type OverpassElement = OverpassNode | OverpassWay | OverpassRelation;

export type PolyGeom = { type: 'Polygon'; coordinates: LonLat[][] } | { type: 'MultiPolygon'; coordinates: LonLat[][][] };

const key = (p: LonLat) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
const toLL = (g: { lat: number; lon: number }[]): LonLat[] => g.map((p) => [p.lon, p.lat]);

/** Stitches open way segments into closed rings by matching endpoints. */
export function assembleRings(segments: LonLat[][]): LonLat[][] {
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings: LonLat[][] = [];
  while (pool.length) {
    let ring = pool.shift()!;
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const end = key(ring[ring.length - 1]);
      const i = pool.findIndex((s) => key(s[0]) === end || key(s[s.length - 1]) === end);
      if (i < 0) break; // unclosable — dropped below
      const seg = pool.splice(i, 1)[0];
      ring = ring.concat(key(seg[0]) === end ? seg.slice(1) : seg.slice().reverse().slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

export function pointInRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolyGeom(p: LonLat, g: PolyGeom): boolean {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((rings) => pointInRing(p, rings[0]) && !rings.slice(1).some((h) => pointInRing(p, h)));
}

/** Planar area in m² (equirectangular approximation — fine for city-scale rings). */
export function ringAreaM2(ring: LonLat[]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring[0][1];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * kx * (ring[i][1] * ky) - ring[i][0] * kx * (ring[j][1] * ky);
  }
  return Math.abs(s / 2);
}

export function polyGeomAreaM2(g: PolyGeom): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.reduce((sum, rings) => sum + ringAreaM2(rings[0]) - rings.slice(1).reduce((h, r) => h + ringAreaM2(r), 0), 0);
}

/** Area-weighted centroid of the largest outer ring. */
export function polyGeomCenter(g: PolyGeom): LonLat {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const outer = polys.map((p) => p[0]).sort((a, b) => ringAreaM2(b) - ringAreaM2(a))[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const f = outer[j][0] * outer[i][1] - outer[i][0] * outer[j][1];
    a += f;
    cx += (outer[j][0] + outer[i][0]) * f;
    cy += (outer[j][1] + outer[i][1]) * f;
  }
  if (Math.abs(a) < 1e-14) return outer[0];
  const c: LonLat = [cx / (3 * a), cy / (3 * a)];
  return pointInRing(c, outer) ? c : outer[Math.floor(outer.length / 2)];
}

/** Builds polygon geometry from a closed way or a multipolygon/boundary relation. */
export function elementToPolygon(el: OverpassElement): PolyGeom | null {
  if (el.type === 'way') {
    if (!el.geometry || el.geometry.length < 4) return null;
    const ring = toLL(el.geometry);
    if (key(ring[0]) !== key(ring[ring.length - 1])) return null;
    return { type: 'Polygon', coordinates: [ring] };
  }
  if (el.type === 'relation') {
    const seg = (role: string) =>
      el.members.filter((m) => m.type === 'way' && m.geometry && (role === 'outer' ? m.role === 'outer' || m.role === '' : m.role === role)).map((m) => toLL(m.geometry!));
    const outers = assembleRings(seg('outer'));
    const inners = assembleRings(seg('inner'));
    if (!outers.length) return null;
    const polys: LonLat[][][] = outers.map((o) => [o]);
    for (const h of inners) {
      const owner = polys.find((p) => pointInRing(h[0], p[0]));
      if (owner) owner.push(h);
    }
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  return null;
}

// ------------------------------------------------------------- simplification

function perpDistM(p: LonLat, a: LonLat, b: LonLat, kx: number, ky: number) {
  const [x, y] = [p[0] * kx, p[1] * ky];
  const [x1, y1] = [a[0] * kx, a[1] * ky];
  const [x2, y2] = [b[0] * kx, b[1] * ky];
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** Douglas–Peucker with a tolerance in metres; keeps rings closed and valid. */
export function simplifyRing(ring: LonLat[], tolM: number): LonLat[] {
  if (ring.length <= 8) return ring;
  const kx = 111320 * Math.cos((ring[0][1] * Math.PI) / 180);
  const ky = 110574;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistM(ring[i], ring[s], ring[e], kx, ky);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > tolM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

export function simplifyPolyGeom(g: PolyGeom, tolM: number, digits = 5): PolyGeom {
  const r = (ring: LonLat[]) => simplifyRing(ring, tolM).map((p) => [+p[0].toFixed(digits), +p[1].toFixed(digits)] as LonLat);
  return g.type === 'Polygon'
    ? { type: 'Polygon', coordinates: g.coordinates.map(r) }
    : { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(r)) };
}
