import type { City, Provenance, TimePoint } from '../../types/data';
import { getBackend, upstreamBase } from '../backend';
import { FeedError, fetchJson, localParts, minutesAgo, parseLocal } from '../http';

/**
 * Ground-level air-quality stations (real measurements) from three adapters:
 *   - İBB Hava Kalitesi (Istanbul municipal reference stations, keyless, via proxy)
 *   - Sensor.Community (citizen low-cost PM sensors, keyless, CORS)
 *   - OpenAQ v3 (global aggregator; needs OPENAQ_API_KEY, served via the dev proxy)
 * Values are normalised to µg/m³. Low-cost sensors are flagged — they are uncalibrated
 * and over-read in high humidity.
 */

export type StationProvider = 'ibb' | 'sensor.community' | 'openaq';
export type Pollutant = 'pm25' | 'pm10' | 'no2' | 'o3' | 'so2' | 'co';

export interface Station {
  id: string;
  name: string;
  lon: number;
  lat: number;
  provider: StationProvider;
  grade: 'reference' | 'low-cost';
  values: Partial<Record<Pollutant, number>>;
  measuredAt: string | null; // ISO
}

export interface StationSource {
  id: StationProvider;
  label: string;
  state: 'ok' | 'error' | 'offline' | 'empty';
  detail: string;
  count: number;
}

export interface StationFeed {
  stations: Station[];
  /** Hourly network medians (only providers that expose history). */
  history: TimePoint[];
  sources: StationSource[];
  /** 'backend' when polled server-side (history from stored PostGIS readings). */
  servedBy?: 'backend' | 'browser';
  polledAt?: string;
}

/**
 * Backend mode: the server polls every provider on a schedule, stores readings and
 * pushes updates over WebSocket (see useSensorSocket). Direct mode polls from the browser.
 */
export async function fetchStationFeed(city: City, signal?: AbortSignal): Promise<StationFeed> {
  if (await getBackend()) {
    return fetchJson<StationFeed>(`/api/v1/cities/${city.id}/stations`, { signal, timeoutMs: 120_000 });
  }
  return { ...(await fetchStations(city, signal)), servedBy: 'browser', polledAt: new Date().toISOString() };
}

export const PROVIDER_PROVENANCE: Record<StationProvider, Provenance> = {
  ibb: { source: 'sensor', provider: 'İBB Hava Kalitesi stations', note: 'Istanbul Metropolitan Municipality reference monitoring stations (hourly).' },
  'sensor.community': { source: 'sensor', provider: 'Sensor.Community', note: 'Citizen low-cost PM sensors (5-min). Uncalibrated; over-reads in high humidity.' },
  openaq: { source: 'sensor', provider: 'OpenAQ', note: 'Aggregated government and research monitors.' },
};

const STALE_MIN = 6 * 60; // ignore readings older than 6 h

// -------------------------------------------------------------------- İBB (Istanbul)

const IST_TZ = 'Europe/Istanbul';

interface IbbStation { Id: string; Name: string; Adress: string; Location: string }
interface IbbReading {
  ReadTime: string;
  Concentration: Partial<Record<'PM10' | 'PM25' | 'NO2' | 'O3' | 'SO2' | 'CO', number | null>> | null;
}
const IBB_KEYS: Record<string, Pollutant> = { PM25: 'pm25', PM10: 'pm10', NO2: 'no2', O3: 'o3', SO2: 'so2', CO: 'co' };

function ibbDate(d: Date) {
  const p = localParts(d, IST_TZ);
  // The API samples hourly from StartDate itself, so the window must sit on whole hours.
  return `${p.day}.${p.month}.${p.year} ${p.hour}:00:00`;
}

async function fetchIbb(signal?: AbortSignal): Promise<{ stations: Station[]; history: TimePoint[] }> {
  // Proxied (backend or dev server): the upstream sends a duplicated CORS header browsers reject.
  const IBB = await upstreamBase('ibb-air');
  const list = await fetchJson<IbbStation[]>(`${IBB}/GetAQIStations`, { signal });
  const end = new Date();
  const start = new Date(end.getTime() - 48 * 3600_000);
  const byHour = new Map<string, Partial<Record<Pollutant, number[]>>>();
  const results = await Promise.allSettled(
    list.map(async (s) => {
      const m = /POINT \(([-\d.]+) ([-\d.]+)\)/.exec(s.Location);
      if (!m) return null;
      const rows = await fetchJson<IbbReading[]>(
        `${IBB}/GetAQIByStationId?StationId=${s.Id}&StartDate=${encodeURIComponent(ibbDate(start))}&EndDate=${encodeURIComponent(ibbDate(end))}`,
        { signal, timeoutMs: 40_000 },
      );
      const values: Partial<Record<Pollutant, number>> = {};
      let measuredAt = null as string | null;
      for (const r of rows) {
        if (!r.Concentration) continue;
        const t = parseLocal(r.ReadTime, IST_TZ).toISOString();
        const hour = t.slice(0, 13);
        const bucket = byHour.get(hour) ?? {};
        for (const [k, v] of Object.entries(r.Concentration)) {
          const key = IBB_KEYS[k];
          if (!key || v == null) continue;
          values[key] = v; // rows are chronological → last non-null wins
          measuredAt = t;
          (bucket[key] ??= []).push(v);
        }
        byHour.set(hour, bucket);
      }
      if (minutesAgo(measuredAt) > STALE_MIN) return null;
      return { id: `ibb-${s.Id}`, name: s.Name, lon: +m[1], lat: +m[2], provider: 'ibb', grade: 'reference', values, measuredAt } satisfies Station;
    }),
  );
  const stations = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
  const history = [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, v]) => ({ time: `${hour}:00:00.000Z`, pm10: median(v.pm10), pm25: median(v.pm25), no2: median(v.no2) }));
  return { stations, history };
}

// -------------------------------------------------------------------- Sensor.Community

interface ScEntry {
  timestamp: string; // UTC "YYYY-MM-DD HH:MM:SS"
  location: { id: number; latitude: string; longitude: string; indoor: number };
  sensor: { id: number; sensor_type: { name: string } };
  sensordatavalues: { value_type: string; value: string }[];
}

async function fetchSensorCommunity(city: City, signal?: AbortSignal): Promise<Station[]> {
  const rows = await fetchJson<ScEntry[]>(`https://data.sensor.community/airrohr/v1/filter/area=${city.lat},${city.lon},12`, { signal, timeoutMs: 40_000 });
  const byLoc = new Map<number, Station>();
  for (const r of rows) {
    if (r.location.indoor) continue;
    const p10 = r.sensordatavalues.find((v) => v.value_type === 'P1');
    const p25 = r.sensordatavalues.find((v) => v.value_type === 'P2');
    if (!p10 && !p25) continue;
    const vals: Partial<Record<Pollutant, number>> = {};
    // Discard physically implausible low-cost readings (sensor faults / fog saturation).
    if (p10 && +p10.value >= 0 && +p10.value < 500) vals.pm10 = +p10.value;
    if (p25 && +p25.value >= 0 && +p25.value < 500) vals.pm25 = +p25.value;
    if (!Object.keys(vals).length) continue;
    byLoc.set(r.location.id, {
      id: `sc-${r.location.id}`,
      name: `${r.sensor.sensor_type.name} #${r.sensor.id}`,
      lon: +r.location.longitude,
      lat: +r.location.latitude,
      provider: 'sensor.community',
      grade: 'low-cost',
      values: vals,
      measuredAt: new Date(`${r.timestamp.replace(' ', 'T')}Z`).toISOString(),
    });
  }
  return [...byLoc.values()].slice(0, 400);
}

// -------------------------------------------------------------------- OpenAQ v3 (via proxy)

interface OaLocation {
  id: number;
  name: string;
  coordinates: { latitude: number; longitude: number };
  isMonitor: boolean;
  datetimeLast: { utc: string } | null;
  sensors: { id: number; parameter: { name: string; units: string } }[];
}
interface OaLatest { datetime: { utc: string }; value: number; sensorsId: number }

/** Convert gas readings reported in ppm/ppb to µg/m³ (25 °C, 1 atm). */
function toUgm3(param: Pollutant, value: number, units: string): number {
  const mw: Partial<Record<Pollutant, number>> = { no2: 46.01, o3: 48.0, so2: 64.07, co: 28.01 };
  const u = units.toLowerCase();
  if (!mw[param] || u.includes('µg') || u.includes('ug')) return value;
  const ppb = u === 'ppm' ? value * 1000 : value;
  return (ppb * mw[param]!) / 24.45;
}

async function fetchOpenAq(city: City, signal?: AbortSignal): Promise<Station[]> {
  const oaq = await upstreamBase('openaq');
  const locs = await fetchJson<{ results: OaLocation[] }>(`${oaq}/v3/locations?coordinates=${city.lat},${city.lon}&radius=25000&limit=60`, { signal });
  const fresh = locs.results.filter((l) => minutesAgo(l.datetimeLast?.utc ?? null) < STALE_MIN).slice(0, 25); // stay inside 60 req/min
  const results = await Promise.allSettled(
    fresh.map(async (l) => {
      const latest = await fetchJson<{ results: OaLatest[] }>(`${oaq}/v3/locations/${l.id}/latest`, { signal });
      const sensor = new Map(l.sensors.map((s) => [s.id, s.parameter]));
      const values: Partial<Record<Pollutant, number>> = {};
      let measuredAt = null as string | null;
      for (const r of latest.results) {
        const p = sensor.get(r.sensorsId);
        const key = p && (['pm25', 'pm10', 'no2', 'o3', 'so2', 'co'] as Pollutant[]).find((k) => k === p.name);
        if (!key || r.value == null || r.value < 0 || minutesAgo(r.datetime.utc) > STALE_MIN) continue;
        values[key] = +toUgm3(key, r.value, p.units).toFixed(1);
        measuredAt = measuredAt && measuredAt > r.datetime.utc ? measuredAt : r.datetime.utc;
      }
      if (!Object.keys(values).length) return null;
      return { id: `oaq-${l.id}`, name: l.name, lon: l.coordinates.longitude, lat: l.coordinates.latitude, provider: 'openaq', grade: l.isMonitor ? 'reference' : 'low-cost', values, measuredAt } satisfies Station;
    }),
  );
  return results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}

// -------------------------------------------------------------------- combined

export async function fetchStations(city: City, signal?: AbortSignal): Promise<StationFeed> {
  const sources: StationSource[] = [];
  const stations: Station[] = [];
  let history: TimePoint[] = [];

  const run = async <T,>(id: StationProvider, label: string, applies: boolean, fn: () => Promise<T>, take: (v: T) => Station[]) => {
    if (!applies) {
      sources.push({ id, label, state: 'offline', detail: 'No coverage configured for this city', count: 0 });
      return;
    }
    try {
      const v = await fn();
      const list = take(v);
      stations.push(...list);
      sources.push({ id, label, state: list.length ? 'ok' : 'empty', detail: list.length ? `${list.length} stations reporting` : 'No current readings in range', count: list.length });
    } catch (e) {
      const unavailable = e instanceof FeedError && e.kind === 'unavailable';
      sources.push({
        id,
        label,
        state: unavailable ? 'offline' : 'error',
        detail: id === 'openaq' && unavailable ? 'Set OPENAQ_API_KEY in .env.local (see .env.example) and restart the dev server' : (e as Error).message,
        count: 0,
      });
    }
  };

  await Promise.all([
    run('ibb', 'İBB Hava Kalitesi', city.id === 'istanbul', () => fetchIbb(signal), (v) => {
      history = v.history;
      return v.stations;
    }),
    run('sensor.community', 'Sensor.Community', true, () => fetchSensorCommunity(city, signal), (v) => v),
    run('openaq', 'OpenAQ', true, () => fetchOpenAq(city, signal), (v) => v),
  ]);
  return { stations, history, sources };
}

export interface GroundSummary {
  value: number | null;
  n: number;
  grade: 'reference' | 'low-cost';
}

/** Median across stations, preferring reference monitors when any report the pollutant. */
export function groundMedian(stations: Station[], p: Pollutant): GroundSummary {
  const ref = stations.filter((s) => s.grade === 'reference' && s.values[p] != null);
  const pool = ref.length ? ref : stations.filter((s) => s.values[p] != null);
  return { value: median(pool.map((s) => s.values[p]!)), n: pool.length, grade: ref.length ? 'reference' : 'low-cost' };
}

function median(xs?: number[]): number | null {
  if (!xs?.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(1);
}
