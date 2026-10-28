import type { City, DataSource, Provenance, TimePoint } from '../../types/data';
import { upstreamBase } from '../backend';
import { fetchJson, minutesAgo, parseLocal } from '../http';

/**
 * Real traffic feeds, one adapter per city where a public live source exists:
 *   istanbul → İBB traffic index (live + 8-day history, via same-origin proxy)
 *   london   → TfL road corridor status + live disruptions (CORS)
 *   newyork  → NYC DOT real-time link speeds (Socrata, CORS)
 * Ankara, İzmir, the other Turkish cities and Berlin have no usable live feed (Berlin VIZ stopped updating
 * in 2025), so they keep the simulated model — returned as `null` here.
 */

export interface LiveIncident {
  id: string;
  kind: 'closure' | 'disruption';
  severity: string;
  title: string;
  detail: string;
  lon: number;
  lat: number;
  start: string | null;
  end: string | null;
}

export interface LiveTraffic {
  provenance: Provenance;
  asOf: string | null;
  stale: boolean;
  /** City-wide congestion 0–100 and how it was obtained. */
  cityIndex: number | null;
  indexLabel: string;
  indexSource: DataSource;
  subIndices: { label: string; value: number }[];
  history: TimePoint[] | null; // { time, today, lastWeek }
  /** Real road geometry with measured/derived state; props: name, congestion, speed?, severity? */
  segments: GeoJSON.FeatureCollection | null;
  segmentsNote: string | null;
  incidents: LiveIncident[];
  corridors: { name: string; status: string; description: string }[];
}

export function hasLiveTraffic(cityId: string) {
  return cityId === 'istanbul' || cityId === 'london' || cityId === 'newyork';
}

export async function fetchLiveTraffic(city: City, signal?: AbortSignal): Promise<LiveTraffic | null> {
  if (city.id === 'istanbul') return fetchIstanbul(signal);
  if (city.id === 'london') return fetchLondon(signal);
  if (city.id === 'newyork') return fetchNewYork(signal);
  return null;
}

/** Hourly means for the last 24 h plus the same hours 7 days earlier. */
function todayVsLastWeek(points: { t: number; v: number }[], now = Date.now()): TimePoint[] {
  const hourly = new Map<number, number[]>();
  for (const p of points) {
    const h = Math.floor(p.t / 3600_000);
    (hourly.get(h) ?? hourly.set(h, []).get(h)!).push(p.v);
  }
  const mean = (h: number) => {
    const xs = hourly.get(h);
    return xs?.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };
  const nowH = Math.floor(now / 3600_000);
  const out: TimePoint[] = [];
  for (let h = nowH - 23; h <= nowH; h++) out.push({ time: new Date(h * 3600_000).toISOString(), today: mean(h), lastWeek: mean(h - 168) });
  return out;
}

// ---------------------------------------------------------------- Istanbul (İBB)

async function fetchIstanbul(signal?: AbortSignal): Promise<LiveTraffic> {
  const base = await upstreamBase('ibb-traffic');
  const [cur, hist] = await Promise.all([
    fetchJson<{ TI: number; TI_An: number; TI_Av: number }>(`${base}/TrafficIndex_Sc1_Cont`, { signal }),
    fetchJson<{ TrafficIndex: number; TrafficIndexDate: string }[]>(`${base}/TrafficIndexHistory/8/15M`, { signal }),
  ]);
  const pts = hist.map((h) => ({ t: parseLocal(h.TrafficIndexDate, 'Europe/Istanbul').getTime(), v: h.TrafficIndex }));
  const asOf = pts.length ? new Date(Math.max(...pts.map((p) => p.t))).toISOString() : null;
  return {
    provenance: { source: 'external-api', provider: 'İBB Trafik İndeksi', note: 'Istanbul Metropolitan Municipality city-wide traffic index (%), 15-min resolution. No per-road speeds are published.' },
    asOf,
    stale: minutesAgo(asOf) > 45,
    cityIndex: cur.TI,
    indexLabel: 'İBB traffic index',
    indexSource: 'external-api',
    subIndices: [
      { label: 'European side', value: cur.TI_Av },
      { label: 'Anatolian side', value: cur.TI_An },
    ],
    history: todayVsLastWeek(pts),
    segments: null,
    segmentsNote: 'Per-road colours remain simulated, scaled to the real city index.',
    incidents: [],
    corridors: [],
  };
}

// ---------------------------------------------------------------- London (TfL)

interface TflCorridor { displayName: string; statusSeverity: string; statusSeverityDescription: string }
interface TflDisruption {
  id: string;
  point: string;
  severity: string;
  category: string;
  subCategory: string;
  comments: string;
  currentUpdate: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  lastModifiedTime: string | null;
  location: string;
  hasClosures: boolean;
  streets: { name: string; closure: string; segments: { lineString: string }[] }[] | null;
}

const TFL_WEIGHT: Record<string, number> = { Good: 0, Minor: 25, Moderate: 50, Serious: 75, Severe: 100, Closure: 100 };
const TFL_SEV_CONGESTION: Record<string, number> = { Serious: 85, Moderate: 65, Minimal: 40, 'No impact': 15 };

async function fetchLondon(signal?: AbortSignal): Promise<LiveTraffic> {
  const [corridors, disruptions] = await Promise.all([
    fetchJson<TflCorridor[]>('https://api.tfl.gov.uk/Road', { signal }),
    fetchJson<TflDisruption[]>('https://api.tfl.gov.uk/Road/all/Disruption', { signal }),
  ]);
  const segments: GeoJSON.Feature[] = [];
  const incidents: LiveIncident[] = [];
  for (const d of disruptions) {
    let lonlat: [number, number] | null = null;
    try {
      lonlat = JSON.parse(d.point) as [number, number];
    } catch {
      /* some disruptions have no point */
    }
    const closed = (d.streets ?? []).some((s) => s.closure && s.closure !== 'Open');
    if (lonlat) {
      incidents.push({
        id: `tfl-${d.id}`,
        kind: closed ? 'closure' : 'disruption',
        severity: d.severity,
        title: `${d.category}${d.subCategory ? ` · ${d.subCategory}` : ''}`,
        detail: (d.comments || d.location || '').replace(/\s+/g, ' ').slice(0, 280),
        lon: lonlat[0],
        lat: lonlat[1],
        start: d.startDateTime,
        end: d.endDateTime,
      });
    }
    for (const s of d.streets ?? []) {
      for (const seg of s.segments ?? []) {
        try {
          const coords = JSON.parse(seg.lineString) as [number, number][];
          if (coords.length < 2) continue;
          segments.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: { name: s.name, severity: d.severity, closure: s.closure, congestion: s.closure === 'Closed' ? 100 : (TFL_SEV_CONGESTION[d.severity] ?? 40), source: 'TfL disruption' },
          });
        } catch {
          /* malformed segment */
        }
      }
    }
  }
  const weights = corridors.map((c) => TFL_WEIGHT[c.statusSeverity] ?? 0);
  const asOf = disruptions.map((d) => d.lastModifiedTime).filter(Boolean).sort().pop() ?? new Date().toISOString();
  return {
    provenance: { source: 'external-api', provider: 'Transport for London Unified API', note: 'Live strategic road corridor status and road disruptions (TIMS).' },
    asOf,
    stale: false,
    cityIndex: weights.length ? Math.round(weights.reduce((a, b) => a + b, 0) / weights.length) : null,
    indexLabel: 'Corridor delay index',
    indexSource: 'estimated',
    subIndices: [
      { label: 'Corridors with delays', value: corridors.filter((c) => c.statusSeverity !== 'Good').length },
      { label: 'Active disruptions', value: disruptions.length },
    ],
    history: null,
    segments: { type: 'FeatureCollection', features: segments },
    segmentsNote: 'Lines are streets affected by live TfL disruptions, coloured by severity. Other roads have no live speed data.',
    incidents,
    corridors: corridors.map((c) => ({ name: c.displayName, status: c.statusSeverity, description: c.statusSeverityDescription })),
  };
}

// ---------------------------------------------------------------- New York (NYC DOT)

interface NycRow { link_id: string; link_name?: string; borough?: string; speed: string; data_as_of: string; link_points?: string }
const NYC = 'https://data.cityofnewyork.us/resource/i4gi-tjb9.json';
const NY_TZ = 'America/New_York';

function nycWhereSince(d: Date) {
  // data_as_of is NY local time without zone
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: NY_TZ, dateStyle: 'short', timeStyle: 'medium' }).format(d).replace(' ', 'T');
  return `data_as_of > '${p}'`;
}

function parseLinkPoints(s?: string): [number, number][] {
  if (!s) return [];
  return s
    .trim()
    .split(/\s+/)
    .map((tok) => tok.split(',').map(Number))
    .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) > 30 && Math.abs(p[1]) > 60)
    .map(([lat, lon]) => [lon, lat] as [number, number]);
}

async function fetchNewYork(signal?: AbortSignal): Promise<LiveTraffic> {
  const now = new Date();
  const q = (params: Record<string, string>) => `${NYC}?${new URLSearchParams(params)}`;
  const [latestRows, recent, lastWeek] = await Promise.all([
    fetchJson<NycRow[]>(q({ $select: 'link_id,link_name,borough,speed,data_as_of,link_points', $order: 'data_as_of DESC', $limit: '1500' }), { signal }),
    fetchJson<NycRow[]>(q({ $select: 'link_id,speed,data_as_of', $where: nycWhereSince(new Date(now.getTime() - 26 * 3600_000)), $limit: '60000' }), { signal, timeoutMs: 45_000 }),
    fetchJson<NycRow[]>(
      q({ $select: 'link_id,speed,data_as_of', $where: `${nycWhereSince(new Date(now.getTime() - 194 * 3600_000))} AND ${nycWhereSince(new Date(now.getTime() - 168 * 3600_000)).replace('>', '<=')}`, $limit: '60000' }),
      { signal, timeoutMs: 45_000 },
    ),
  ]);

  // Free-flow reference per link: 90th percentile of its speeds over the last ~day.
  const speeds = new Map<string, number[]>();
  for (const r of recent) (speeds.get(r.link_id) ?? speeds.set(r.link_id, []).get(r.link_id)!).push(+r.speed);
  const freeFlow = (id: string) => {
    const xs = (speeds.get(id) ?? []).filter((v) => v > 0).sort((a, b) => a - b);
    return xs.length >= 10 ? xs[Math.floor(xs.length * 0.9)] : null;
  };
  const congestion = (id: string, v: number) => {
    const ff = freeFlow(id);
    return ff ? Math.round(Math.max(0, Math.min(100, (1 - v / ff) * 100))) : null;
  };

  const latest = new Map<string, NycRow>();
  for (const r of latestRows) if (!latest.has(r.link_id)) latest.set(r.link_id, r);
  const features: GeoJSON.Feature[] = [];
  const cong: number[] = [];
  let asOf: string | null = null;
  for (const r of latest.values()) {
    const coords = parseLinkPoints(r.link_points);
    const t = parseLocal(r.data_as_of.slice(0, 19), NY_TZ).toISOString();
    if (!asOf || t > asOf) asOf = t;
    const c = congestion(r.link_id, +r.speed);
    if (c != null && minutesAgo(t) < 180) cong.push(c);
    if (coords.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { name: r.link_name ?? `Link ${r.link_id}`, borough: r.borough ?? '', speedMph: +(+r.speed).toFixed(1), congestion: c ?? -1, measuredAt: t, source: 'NYC DOT' },
      });
    }
  }
  const series = (rows: NycRow[]) =>
    rows.flatMap((r) => {
      const c = congestion(r.link_id, +r.speed);
      return c == null ? [] : [{ t: parseLocal(r.data_as_of.slice(0, 19), NY_TZ).getTime(), v: c }];
    });
  cong.sort((a, b) => a - b);
  return {
    provenance: { source: 'sensor', provider: 'NYC DOT real-time traffic speeds', note: 'Measured link speeds (mph) from NYC DOT/TRANSCOM sensors. Congestion % is derived against each link’s 24 h 90th-percentile speed.' },
    asOf,
    stale: minutesAgo(asOf) > 60,
    cityIndex: cong.length ? cong[Math.floor(cong.length / 2)] : null,
    indexLabel: 'Median link congestion',
    indexSource: 'estimated',
    subIndices: [
      { label: 'Links reporting', value: latest.size },
      { label: 'Median speed (mph)', value: Math.round(median([...latest.values()].map((r) => +r.speed))) },
    ],
    history: todayVsLastWeek([...series(recent), ...series(lastWeek)]),
    segments: { type: 'FeatureCollection', features },
    segmentsNote: 'Measured speeds on NYC DOT sensor links (mostly highways and arterials).',
    incidents: [],
    corridors: [],
  };
}

function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
