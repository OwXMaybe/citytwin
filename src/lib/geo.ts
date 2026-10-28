const KM_PER_DEG_LAT = 110.574;

export function kmToDeg(km: number, lat: number): { dLon: number; dLat: number } {
  return { dLat: km / KM_PER_DEG_LAT, dLon: km / (111.32 * Math.cos((lat * Math.PI) / 180)) };
}

/** Flat-top hexagon ring around (lon, lat). */
export function hexRing(lon: number, lat: number, radiusKm: number): [number, number][] {
  const { dLon, dLat } = kmToDeg(radiusKm, lat);
  const ring: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = (Math.PI / 3) * (i % 6);
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}

/** Axial flat-top hex grid centres within `rings` of the origin. */
export function hexGrid(lon: number, lat: number, rings: number, radiusKm: number) {
  const { dLon, dLat } = kmToDeg(radiusKm, lat);
  const cells: { q: number; r: number; lon: number; lat: number }[] = [];
  for (let q = -rings; q <= rings; q++) {
    for (let r = Math.max(-rings, -q - rings); r <= Math.min(rings, -q + rings); r++) {
      const x = 1.5 * q;
      const y = Math.sqrt(3) * (r + q / 2);
      cells.push({ q, r, lon: lon + x * dLon, lat: lat + y * dLat });
    }
  }
  return cells;
}

export function pointInRing(lon: number, lat: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Planar polygon area in m² for small (building-sized) rings. */
export function ringAreaM2(ring: number[][]) {
  if (ring.length < 3) return 0;
  const lat0 = ring[0][1];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  }
  return Math.abs(s / 2);
}

export function hexAreaKm2(radiusKm: number) {
  return ((3 * Math.sqrt(3)) / 2) * radiusKm * radiusKm;
}
