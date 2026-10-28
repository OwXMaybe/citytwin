import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { CITIES, DEFAULT_CITY } from '../data/cities';
import { deriveAlerts, deriveInsights } from '../services/analysis';
import { fetchDistricts } from '../services/districts';
import { fetchAirGrid, fetchAirQuality, fetchWeather } from '../services/openMeteo';
import type { City, DistrictCollection, Provenance, TrafficIncident } from '../types/data';
import { fetchStationFeed, groundMedian } from '../services/air/stations';
import { getBackend } from '../services/backend';
import { anomalyAlerts, fetchAnomalies } from '../services/anomalies';
import { useSensorSocket } from './useSensorSocket';
import { fetchLiveTraffic, hasLiveTraffic } from '../services/traffic/live';
import {
  buildZones,
  congestionAt,
  energyHistory,
  monitoredAreaKm2,
  SIM_PROVENANCE,
  simulatedIncidents,
  trafficHistory,
} from '../services/simulated';
import { useAppStore } from '../store/useAppStore';
import { t, locale } from '../i18n';

export type FeedState = 'ok' | 'loading' | 'error' | 'offline';

export interface Feed {
  id: string;
  label: string;
  state: FeedState;
  detail: string;
}

/**
 * Single entry point for city data. Real feeds go through react-query (caching,
 * retries, refetch interval); simulated data is derived synchronously and memoised.
 */
export function useCityData() {
  const cityId = useAppStore((s) => s.cityId);
  const refreshMinutes = useAppStore((s) => s.settings.refreshMinutes);
  const base = CITIES.find((c) => c.id === cityId) ?? DEFAULT_CITY;
  // Display name in the UI language (İstanbul, Londra…); the id stays the key everywhere.
  const city = useMemo(() => ({ ...base, name: t(base.name) }), [base]);
  const refetchInterval = refreshMinutes > 0 ? refreshMinutes * 60_000 : false;

  const weather = useQuery({
    queryKey: ['weather', city.id],
    queryFn: ({ signal }) => fetchWeather(city, signal),
    refetchInterval,
  });
  const air = useQuery({
    queryKey: ['air', city.id],
    queryFn: ({ signal }) => fetchAirQuality(city, signal),
    refetchInterval,
  });
  const districts = useQuery({
    queryKey: ['districts', city.id],
    queryFn: ({ signal }) => fetchDistricts(city.id, signal),
    staleTime: Infinity,
  });
  // Sample the air model across the district extent (capped so the grid stays regional).
  const extent = useMemo(() => (districts.data ? districtExtent(districts.data, city) : null), [districts.data, city]);
  const airGrid = useQuery({
    queryKey: ['airGrid', city.id, extent?.join(',')],
    queryFn: ({ signal }) => fetchAirGrid(city, signal, extent ?? undefined),
    enabled: !districts.isLoading,
    refetchInterval,
  });

  // ---- Phase 3 real feeds
  const liveTraffic = useQuery({
    queryKey: ['liveTraffic', city.id],
    queryFn: ({ signal }) => fetchLiveTraffic(city, signal),
    enabled: hasLiveTraffic(city.id),
    refetchInterval: refetchInterval && Math.min(refetchInterval, 5 * 60_000),
    retry: 1,
  });
  // Phase 4: prefer the backend (server-side polling + WebSocket push) when it is up.
  const backend = useQuery({ queryKey: ['backend'], queryFn: () => getBackend(true), refetchInterval: 30_000, retry: false, staleTime: 25_000 });
  const socket = useSensorSocket(city.id, !!backend.data);
  const stations = useQuery({
    queryKey: ['stations', city.id, backend.data ? 'backend' : 'browser'],
    queryFn: ({ signal }) => fetchStationFeed(city, signal),
    enabled: !backend.isLoading,
    // With a live socket the server pushes updates; polling is only the fallback.
    refetchInterval: socket.state === 'open' ? false : refetchInterval,
    retry: 1,
  });
  // Phase 5: anomaly scan of measured readings (backend only; pushed over the socket after each poll).
  const anomalies = useQuery({
    queryKey: ['anomalies', city.id],
    queryFn: ({ signal }) => fetchAnomalies(city.id, signal),
    enabled: !!backend.data,
    refetchInterval: socket.state === 'open' ? false : refetchInterval,
    retry: 1,
  });
  const ground = useMemo(() => {
    const list = stations.data?.stations ?? [];
    return { pm25: groundMedian(list, 'pm25'), pm10: groundMedian(list, 'pm10'), no2: groundMedian(list, 'no2'), count: list.length };
  }, [stations.data]);

  // Simulated data re-derives on each refetch tick so time-of-day shapes advance.
  // Where a live traffic index exists it drives the city level instead of the model.
  const tick = weather.dataUpdatedAt || 0;
  const live = liveTraffic.data ?? null;
  const sim = useMemo(() => {
    const now = new Date();
    const congestionNow = live?.cityIndex ?? congestionAt(city, now);
    // Zone indices are typical-peak values; scale them by the current city level.
    const zones = buildZones(city, districts.data).map((z) => ({
      ...z,
      trafficIndex: Math.round(Math.min(99, z.trafficIndex * (0.25 + (0.75 * congestionNow) / 90))),
    }));
    const liveIncidents: TrafficIncident[] | null = live
      ? live.incidents.map((i) => ({ id: i.id, kind: i.kind, lon: i.lon, lat: i.lat, title: i.title, detail: i.detail, severity: i.severity, live: true }))
      : null;
    return {
      zones,
      areaKm2: monitoredAreaKm2(zones),
      congestionNow,
      trafficHistory: live?.history ?? trafficHistory(city, now),
      energyHistory: energyHistory(city, zones, now),
      incidents: liveIncidents ?? simulatedIncidents(city),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.id, tick, districts.data, live]);

  /** Provenance of the traffic values currently shown (live feed vs simulation). */
  const trafficProvenance: Provenance = live
    ? { ...live.provenance, source: live.indexSource === 'external-api' ? live.provenance.source : 'estimated', note: `${t(live.indexLabel)}. ${t(live.provenance.note ?? '')}` }
    : SIM_PROVENANCE;

  const alerts = useMemo(
    () => [
      ...anomalyAlerts(anomalies.data),
      ...deriveAlerts({ city, weather: weather.data, air: air.data, zones: sim.zones, congestionNow: sim.congestionNow, weatherError: weather.error, airError: air.error, ground, trafficProvenance, liveIncidents: live?.incidents ?? [] }),
    ],
    // trafficProvenance derives from `live`
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [city, weather.data, air.data, sim, weather.error, air.error, ground, live, anomalies.data],
  );
  const insights = useMemo(
    () => deriveInsights({ city, weather: weather.data, air: air.data, zones: sim.zones, congestionNow: sim.congestionNow, trafficHistory: sim.trafficHistory, ground, trafficProvenance, stationHistory: stations.data?.history ?? [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [city, weather.data, air.data, sim, ground, live, stations.data],
  );

  const feedState = (q: { isLoading: boolean; isError: boolean }): FeedState =>
    q.isLoading ? 'loading' : q.isError ? 'error' : 'ok';

  const feeds: Feed[] = [
    { id: 'weather', label: 'Open-Meteo weather', state: feedState(weather), detail: weather.error?.message ?? 'External API · model data' },
    { id: 'air', label: 'Open-Meteo air quality', state: feedState(air), detail: air.error?.message ?? 'External API · CAMS model' },
    { id: 'osm', label: 'OpenStreetMap tiles', state: 'ok', detail: 'OpenFreeMap vector tiles' },
    {
      id: 'districts',
      label: 'District boundaries',
      state: districts.isLoading ? 'loading' : districts.isError ? 'error' : districts.data ? 'ok' : 'offline',
      detail: districts.error?.message ?? (districts.data
        ? t('{n} OSM {unit} · imported {date}', { n: districts.data.features.length, unit: t(districts.data.metadata.unit), date: new Date(districts.data.metadata.importedAt).toLocaleDateString(locale()) })
        : 'Not imported for this city — using synthetic hex grid'),
    },
    hasLiveTraffic(city.id)
      ? {
          id: 'traffic',
          label: live?.provenance.provider ?? 'Live traffic',
          state: liveTraffic.isLoading ? 'loading' : liveTraffic.isError ? 'error' : live?.stale ? 'error' : 'ok',
          detail: liveTraffic.error?.message ?? (live ? `${live.stale ? `${t('Delayed')} — ` : ''}${t('as of {when}', { when: live.asOf ? new Date(live.asOf).toLocaleString(locale()) : '—' })}` : 'Connecting…'),
        }
      : { id: 'traffic', label: 'Live traffic', state: 'offline', detail: 'No public live feed for this city — traffic is simulated' },
    ...(stations.data?.sources ?? []).map((s) => ({
      id: `air-${s.id}`,
      label: `${t(s.label)} (${t('ground stations')})`,
      state: (s.state === 'empty' ? 'offline' : s.state) as FeedState,
      detail: s.detail,
    })),
    ...(stations.isLoading ? [{ id: 'air-stations', label: 'Ground air stations', state: 'loading' as FeedState, detail: 'Connecting…' }] : []),
    { id: 'sim', label: 'Synthetic generator', state: 'ok', detail: live ? 'Energy, zone metrics (demo data)' : 'Traffic, energy, zone metrics (demo data)' },
    backend.data
      ? { id: 'backend', label: 'CityTwin API (PostGIS)', state: 'ok', detail: t('v{v} · PostGIS {pg} · {d} districts · {r} stored readings', { v: backend.data.version, pg: backend.data.postgis, d: backend.data.districts, r: backend.data.readings.toLocaleString(locale()) }) }
      : { id: 'backend', label: 'CityTwin API', state: backend.isLoading ? 'loading' : 'offline', detail: 'Not reachable — running in direct mode (browser polls providers)' },
    ...(backend.data ? [{ id: 'ws', label: 'Live sensor WebSocket', state: (socket.state === 'open' ? 'ok' : socket.state === 'connecting' ? 'loading' : 'error') as FeedState, detail: socket.lastMessageAt ? t('last push {when}', { when: new Date(socket.lastMessageAt).toLocaleTimeString(locale()) }) : socket.state }] : []),
    ...(backend.data
      ? [
          { id: 'anomalies', label: 'Anomaly detector (ML)', state: feedState(anomalies), detail: anomalies.error?.message ?? (anomalies.data ? t('{n} flagged · scanned {when}', { n: anomalies.data.anomalies.length, when: new Date(anomalies.data.generatedAt).toLocaleTimeString(locale()) }) : 'Waiting for first scan') },
          backend.data.ai?.enabled
            ? { id: 'ai', label: 'CityTwin AI (Claude)', state: 'ok' as FeedState, detail: `${backend.data.ai.model} · ${t('effort')} ${backend.data.ai.effort}` }
            : { id: 'ai', label: 'CityTwin AI (Claude)', state: 'offline' as FeedState, detail: 'Set ANTHROPIC_API_KEY in .env.local and restart the backend — the rule-based assistant is used meanwhile' },
        ]
      : []),
  ];

  return { city, weather, air, airGrid, districts, liveTraffic, stations, ground, trafficProvenance, backend, socket, anomalies, ...sim, alerts, insights, feeds };
}

/** District bounding box, clamped to ±0.6° around the centre (keeps 25 samples meaningful). */
function districtExtent(d: DistrictCollection, city: City): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of d.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) for (const [x, y] of p[0]) {
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
  }
  const c = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return [c(w, city.lon - 0.6, city.lon), c(s, city.lat - 0.6, city.lat), c(e, city.lon, city.lon + 0.6), c(n, city.lat, city.lat + 0.6)].map((v) => +v.toFixed(3)) as [number, number, number, number];
}

export type CityData = ReturnType<typeof useCityData>;
