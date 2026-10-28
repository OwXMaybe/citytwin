import { GRID } from '../data/cities';
import { hexAreaKm2, hexGrid, hexRing, kmToDeg } from '../lib/geo';
import { hashCoord, hashString, seeded } from '../lib/random';
import type { City, DistrictCollection, Provenance, TimePoint, TrafficIncident, Zone, ZoneGeometry } from '../types/data';

/**
 * Synthetic data generator for modules that have no public live feed yet
 * (traffic, energy, zone demographics). Everything here is deterministic per city
 * and is ALWAYS tagged `simulated` or `estimated` — never presented as a measurement.
 * Phase 4 replaces these functions with backend endpoints fed by real datasets.
 */

export const SIM_PROVENANCE: Provenance = {
  source: 'simulated',
  provider: 'CityTwin synthetic generator',
  note: 'Demo data for development. Shape follows typical urban patterns; values are not measurements.',
};

export const NOISE_PROVENANCE: Provenance = {
  source: 'estimated',
  provider: 'CityTwin noise model',
  note: 'Estimated from simulated traffic intensity (Leq ≈ 48 + 0.32·traffic index). No noise sensors connected.',
};

export const SOLAR_PROVENANCE: Provenance = {
  source: 'estimated',
  provider: 'CityTwin solar model',
  note: 'Annual rooftop yield estimate from latitude only (no irradiance or roof geometry data yet).',
};

/** Typical weekday traffic shape: AM and PM peaks. Returns 0..1. */
export function trafficProfile(hour: number, weekend = false): number {
  const g = (mu: number, s: number) => Math.exp(-((hour - mu) ** 2) / (2 * s * s));
  if (weekend) return 0.18 + 0.55 * g(14, 3.5);
  return 0.12 + 0.78 * g(8.3, 1.4) + 0.88 * g(18, 1.8) + 0.35 * g(13, 2.5);
}

/** Typical electricity demand shape. Returns 0..1. */
export function energyProfile(hour: number): number {
  const g = (mu: number, s: number) => Math.exp(-((hour - mu) ** 2) / (2 * s * s));
  return 0.45 + 0.3 * g(9, 2) + 0.45 * g(19.5, 2.2) + 0.15 * g(14, 3);
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Synthetic analysis zones are named by compass bearing and ring from the centre. */
function zoneName(q: number, r: number, lon: number, lat: number, city: City): string {
  if (q === 0 && r === 0) return 'Central';
  const dx = (lon - city.lon) * Math.cos((city.lat * Math.PI) / 180);
  const bearing = ((Math.atan2(dx, lat - city.lat) * 180) / Math.PI + 360) % 360;
  const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r));
  return `${DIRS[Math.round(bearing / 22.5) % 16]}-${ring}`;
}

/** Zone shape before simulated metrics are attached. */
interface ZoneShape {
  id: string;
  name: string;
  kind: Zone['kind'];
  osmId: number | null;
  center: [number, number];
  geometry: ZoneGeometry;
  areaKm2: number;
  osmPopulation: number | null;
  /** 0 (periphery) … 1 (city core) */
  centrality: number;
}

function gridShapes(city: City): ZoneShape[] {
  const names = new Set<string>();
  return hexGrid(city.lon, city.lat, GRID.rings, GRID.hexRadiusKm).map((c) => {
    const ring = Math.max(Math.abs(c.q), Math.abs(c.r), Math.abs(-c.q - c.r));
    let name = zoneName(c.q, c.r, c.lon, c.lat, city);
    while (names.has(name)) name += '′';
    names.add(name);
    return {
      id: `${city.id}-${c.q}_${c.r}`,
      name,
      kind: 'grid',
      osmId: null,
      center: [c.lon, c.lat],
      geometry: { type: 'Polygon', coordinates: [hexRing(c.lon, c.lat, GRID.hexRadiusKm)] },
      areaKm2: hexAreaKm2(GRID.hexRadiusKm),
      osmPopulation: null,
      centrality: 1 - ring / (GRID.rings + 1),
    };
  });
}

function districtShapes(city: City, d: DistrictCollection): ZoneShape[] {
  const dist = (c: [number, number]) => Math.hypot((c[0] - city.lon) * Math.cos((city.lat * Math.PI) / 180), c[1] - city.lat);
  const maxD = Math.max(...d.features.map((f) => dist(f.properties.center)), 1e-6);
  return d.features.map((f) => ({
    id: `${city.id}-osm${f.properties.osmId}`,
    name: f.properties.name,
    kind: 'district',
    osmId: f.properties.osmId,
    center: f.properties.center,
    geometry: f.geometry,
    areaKm2: f.properties.areaKm2,
    osmPopulation: f.properties.population,
    centrality: 1 - dist(f.properties.center) / maxD,
  }));
}

/**
 * Builds analysis zones from real OSM district boundaries when available, falling back
 * to the synthetic hex grid. Geometry, area and (where tagged) population are real;
 * traffic, energy and green share remain simulated.
 */
export function buildZones(city: City, districts?: DistrictCollection | null): Zone[] {
  const rand = seeded(hashString(city.id));
  const solar = Math.round(1700 - Math.abs(city.lat) * 14); // crude latitude model
  const shapes = districts?.features.length ? districtShapes(city, districts) : gridShapes(city);
  return shapes.map((s) => {
    const c = s.centrality;
    // Simulated density: dense core, sparse periphery (people/km²).
    const simPop = Math.round(s.areaKm2 * (400 + 16000 * c ** 2.2) * (0.75 + rand() * 0.5));
    const population = s.osmPopulation ?? simPop;
    const baseline = population * 0.0105 * (0.85 + c * 0.4); // MWh/day
    const anomaly = rand() < 0.12 ? 1.28 + rand() * 0.2 : 0.9 + rand() * 0.2;
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      osmId: s.osmId,
      center: s.center,
      geometry: s.geometry,
      areaKm2: s.areaKm2,
      population,
      populationSource: s.osmPopulation != null ? 'osm' : 'simulated',
      trafficIndex: Math.round(Math.min(96, 25 + 55 * c + rand() * 22)),
      energyMWh: +(baseline * anomaly).toFixed(1),
      energyBaselineMWh: +baseline.toFixed(1),
      greenShare: +Math.min(0.85, 0.06 + 0.55 * (1 - c) ** 1.5 + rand() * 0.1).toFixed(2),
      solarPotentialKWhm2: Math.round(solar * (0.92 + rand() * 0.12)),
    };
  });
}

export function monitoredAreaKm2(zones: Zone[]) {
  return zones.reduce((s, z) => s + z.areaKm2, 0);
}

/** City-wide congestion index for a given time, 0..100 (simulated). */
export function congestionAt(city: City, date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const jitter = seeded(hashString(`${city.id}:${date.toDateString()}:${date.getHours()}`))();
  return Math.round(Math.min(98, 100 * trafficProfile(h, weekend) * (0.82 + jitter * 0.22)));
}

/** Past 24 h congestion with the same hours one week earlier for comparison. */
export function trafficHistory(city: City, now = new Date()): TimePoint[] {
  const out: TimePoint[] = [];
  for (let i = 23; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 3600_000);
    t.setMinutes(0, 0, 0);
    const lastWeek = new Date(t.getTime() - 7 * 86400_000);
    out.push({ time: t.toISOString(), today: congestionAt(city, t), lastWeek: congestionAt(city, lastWeek) });
  }
  return out;
}

/** Past 24 h city-wide electricity demand in MW (simulated). */
export function energyHistory(city: City, zones: Zone[], now = new Date()): TimePoint[] {
  const dailyMWh = zones.reduce((s, z) => s + z.energyMWh, 0);
  const meanMW = dailyMWh / 24;
  const out: TimePoint[] = [];
  for (let i = 23; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 3600_000);
    t.setMinutes(0, 0, 0);
    const j = seeded(hashString(`${city.id}:e:${t.toISOString()}`))();
    const shape = energyProfile(t.getHours()) / 0.62;
    out.push({
      time: t.toISOString(),
      demand: +(meanMW * shape * (0.95 + j * 0.1)).toFixed(1),
      renewable: +(meanMW * shape * 0.18 * Math.max(0, Math.sin(((t.getHours() - 6) / 12) * Math.PI))).toFixed(1),
    });
  }
  return out;
}

const ROAD_WEIGHT: Record<string, number> = {
  motorway: 1.0,
  trunk: 0.95,
  primary: 0.85,
  secondary: 0.7,
  tertiary: 0.55,
  minor: 0.35,
  service: 0.2,
};

/** Simulated congestion for a road segment, stable per location. */
export function roadCongestion(cls: string, lon: number, lat: number, cityLevel: number): number {
  const r = seeded(hashCoord(lon, lat))();
  const w = ROAD_WEIGHT[cls] ?? 0.3;
  return Math.round(Math.max(3, Math.min(99, cityLevel * (0.45 + w * 0.6) + (r - 0.5) * 45)));
}

export function estimateNoiseDb(trafficIndex: number) {
  return +(48 + 0.32 * trafficIndex).toFixed(1);
}


/** A few simulated incidents near the centre so the closure/bottleneck UI can be exercised. */
export function simulatedIncidents(city: City): TrafficIncident[] {
  const rand = seeded(hashString(`${city.id}:incidents`));
  const { dLon, dLat } = kmToDeg(2.2, city.lat);
  return Array.from({ length: 4 }, (_, i) => ({
    id: `${city.id}-inc-${i}`,
    kind: i === 0 ? 'closure' : ('bottleneck' as const),
    lon: city.lon + (rand() - 0.5) * 2 * dLon,
    lat: city.lat + (rand() - 0.5) * 2 * dLat,
    title: i === 0 ? 'Lane closure (simulated works)' : `Recurring bottleneck #${i}`,
    live: false,
  }));
}
