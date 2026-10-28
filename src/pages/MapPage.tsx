import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, MapPinned } from 'lucide-react';
import { CityMap, useMapInstance } from '../components/map/CityMap';
import { OsmImportPanel } from '../components/map/OsmImportPanel';
import { AnomalyList } from '../components/AnomalyList';
import type { BBox } from '../services/osm/viewImport';
import { TimeChart } from '../components/charts/Charts';
import { ErrorState, KV, Loading, SimGate } from '../components/ui/Panel';
import { SourceBadge } from '../components/ui/SourceBadge';
import { useCity } from '../hooks/CityDataContext';
import { aqiBand, congestionBand, fmt, fmtInt } from '../lib/format';
import { AIR_INTERP_PROVENANCE, energyAnomalies, interpolateAir, pctOver, WHO } from '../services/analysis';
import { AIR_PROVENANCE } from '../services/openMeteo';
import { NOISE_PROVENANCE, SIM_PROVENANCE, SOLAR_PROVENANCE, estimateNoiseDb } from '../services/simulated';
import { useAppStore, type PageId } from '../store/useAppStore';
import type { Provenance } from '../types/data';
import { t, locale } from '../i18n';

/** Map-centric module pages share one map and swap the floating analysis panel. */
export function MapPage({ module }: { module: Extract<PageId, 'city3d' | 'traffic' | 'environment' | 'energy'> }) {
  const panels: Record<typeof module, ReactNode> = {
    city3d: <City3DPanel />,
    traffic: <TrafficPanel />,
    environment: <EnvironmentPanel />,
    energy: <EnergyPanel />,
  };
  return <CityMap>{panels[module]}</CityMap>;
}

function FloatingPanel({ title, source, children }: { title: string; source?: Provenance; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="fade-in absolute top-3 right-3 z-10 flex max-h-[calc(100%-6rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col rounded-md border border-ink-600 bg-ink-900/95 shadow-2xl backdrop-blur">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 border-b border-ink-700 px-3 py-2 text-left">
        <span className="text-[11px] font-semibold tracking-wider text-ink-200 uppercase">{t(title)}</span>
        <span className="ml-auto flex items-center gap-2">
          {source && <SourceBadge p={source} compact />}
          {open ? <ChevronUp className="size-4 text-ink-400" /> : <ChevronDown className="size-4 text-ink-400" />}
        </span>
      </button>
      {open && <div className="min-h-0 overflow-y-auto p-3">{children}</div>}
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mt-3 first:mt-0">
    <div className="mb-1 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">{t(title)}</div>
    {children}
  </div>
);

// ------------------------------------------------------------------ 3D city

const OSM_PROV: Provenance = { source: 'external-api', provider: 'OpenStreetMap via OpenFreeMap' };

function City3DPanel() {
  const { city, zones, districts } = useCity();
  const flyTo = useAppStore((s) => s.flyTo);
  const setMapMode = useAppStore((s) => s.setMapMode);
  const select = useAppStore((s) => s.select);
  const mapRef = useMapInstance();
  // Import area = ground visible in the lower part of the canvas (the horizon is excluded when pitched).
  const getViewport = () => {
    const m = mapRef.current;
    if (!m) return null;
    const { width: w, height: h } = m.getCanvas().getBoundingClientRect();
    const pts = [[0, h * 0.35], [w, h * 0.35], [0, h], [w, h]].map(([x, y]) => m.unproject([x, y]));
    const lons = pts.map((p) => p.lng);
    const lats = pts.map((p) => p.lat);
    return { bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] as BBox, zoom: m.getZoom() };
  };
  const views: { label: string; zoom: number; pitch: number; bearing: number }[] = [
    { label: 'Top-down', zoom: city.zoom - 0.5, pitch: 0, bearing: 0 },
    { label: 'Oblique', zoom: city.zoom, pitch: 55, bearing: -17 },
    { label: 'Skyline', zoom: city.zoom + 1.2, pitch: 72, bearing: 35 },
  ];
  return (
    <FloatingPanel title="3D City Model" source={OSM_PROV}>
      <p className="text-ink-300">
        {t('Buildings, roads, parks and rail are rendered from OpenStreetMap vector tiles with real coordinates. Click a building for its attributes; import OSM data for the view to colour buildings by use.')}
      </p>
      <Section title="Camera">
        <div className="grid grid-cols-3 gap-1.5">
          {views.map((v) => (
            <button
              key={v.label}
              onClick={() => {
                setMapMode(v.pitch > 0 ? '3d' : '2d');
                flyTo({ lon: city.lon, lat: city.lat, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing });
              }}
              className="rounded border border-ink-600 py-1.5 text-xs text-ink-200 hover:border-accent hover:text-accent"
            >
              {t(v.label)}
            </button>
          ))}
        </div>
      </Section>
      <Section title={t(zones[0]?.kind === 'district' ? 'Jump to district ({n})' : 'Jump to zone ({n})', { n: zones.length })}>
        <select
          value=""
          onChange={(e) => {
            const z = zones.find((x) => x.id === e.target.value);
            if (!z) return;
            select({ kind: 'zone', zoneId: z.id });
            flyTo({ lon: z.center[0], lat: z.center[1], zoom: Math.max(11, 15.6 - Math.log2(Math.max(1, z.areaKm2)) / 2) });
          }}
          className="h-8 w-full rounded border border-ink-600 bg-ink-800 px-2 text-ink-100 outline-none focus:border-accent"
        >
          <option value="">{t('Choose…')}</option>
          {[...zones].sort((a, b) => a.name.localeCompare(b.name)).map((z) => (
            <option key={z.id} value={z.id}>{z.name} · {fmt(z.areaKm2)} km²</option>
          ))}
        </select>
        {districts.data ? (
          <p className="mt-1 text-[10.5px] text-ink-400">
            {t('{n} OSM {unit} boundaries · OSM data of {date}', { n: districts.data.features.length, unit: t(districts.data.metadata.unit), date: districts.data.metadata.osmTimestamp?.slice(0, 10) ?? t('unknown date') })}
          </p>
        ) : (
          <p className="mt-1 text-[10.5px] text-amber-300/80">{t('No district import for this city — synthetic hex grid in use.')}</p>
        )}
      </Section>
      <Section title="OSM building attributes">
        <OsmImportPanel getViewport={getViewport} />
      </Section>
      <Section title="Data notes">
        <ul className="list-disc space-y-1 pl-4 text-[11.5px] text-ink-400">
          <li>{t('Heights come from OSM height/building:levels tags; untagged buildings use schema defaults.')}</li>
          <li>{t('3D trees: OSM-mapped trees (brighter) plus illustrative fill inside park polygons — not surveyed positions.')}</li>
          <li>{t('District boundaries are refreshed with npm run import:districts.')}</li>
        </ul>
      </Section>
    </FloatingPanel>
  );
}

// ------------------------------------------------------------------ traffic

const TFL_STATUS_COLOR: Record<string, string> = { Good: '#22c55e', Minor: '#84cc16', Moderate: '#eab308', Serious: '#f97316', Severe: '#ef4444', Closure: '#ef4444' };

function TrafficPanel() {
  const { congestionNow, trafficHistory, zones, incidents, liveTraffic, trafficProvenance } = useCity();
  const flyTo = useAppStore((s) => s.flyTo);
  const select = useAppStore((s) => s.select);
  const showSim = useAppStore((s) => s.settings.showSimulated);
  const live = liveTraffic.data;
  const band = congestionBand(congestionNow);
  const top = [...zones].sort((a, b) => b.trafficIndex - a.trafficIndex).slice(0, 5);
  const [showAllIncidents, setShowAllIncidents] = useState(false);
  const incidentList = [...incidents].filter((i) => i.live || showSim).sort((a, b) => (b.kind === 'closure' ? 1 : 0) - (a.kind === 'closure' ? 1 : 0));

  const banner = liveTraffic.isLoading ? (
    <Loading label="Connecting to live traffic feed…" />
  ) : live ? (
    <div className="mb-2 rounded border border-src-api/30 bg-src-api/5 px-2 py-1.5 text-[11px] text-sky-200/90">
      <b>{t('Live:')}</b> {t(live.provenance.provider)}. {t(live.segmentsNote)}
      {live.stale && <span className="text-amber-300"> {t('Feed delayed — latest data {when}.', { when: live.asOf ? new Date(live.asOf).toLocaleString(locale()) : t('unknown') })}</span>}
    </div>
  ) : (
    <div className="mb-2 rounded border border-src-sim/30 bg-src-sim/5 px-2 py-1.5 text-[11px] text-amber-200/90">
      {liveTraffic.isError
        ? <>{t('Live feed unavailable ({err}). Showing synthetic congestion.', { err: (liveTraffic.error as Error).message })}</>
        : <>{t('No public live traffic feed exists for this city yet. Road congestion is synthetic, generated on real OSM road geometry.')}</>}
    </div>
  );

  const body = (
    <>
      <div className="flex items-baseline gap-2">
        <span className="num text-3xl font-semibold" style={{ color: band.color }}>{congestionNow}</span>
        <span className="text-ink-300">/100 · {t(live?.indexLabel ?? 'congestion')} · {band.label}</span>
      </div>
      {live?.subIndices.map((s) => <KV key={s.label} k={s.label} v={s.value} />)}
      {trafficHistory.some((p) => typeof p.today === 'number') && (
        <Section title={`${t('24 h vs same hours last week')}${live?.history ? '' : ` (${t('simulated')})`}`}>
          <TimeChart data={trafficHistory} height={130} yDomain={[0, 100]} series={[{ key: 'today', label: 'Last 24 h', color: '#22d3ee' }, { key: 'lastWeek', label: 'Last week', color: '#5c7096', dashed: true }]} />
        </Section>
      )}
      {live && live.corridors.length > 0 && (
        <Section title={t('Strategic corridors ({n})', { n: live.corridors.length })}>
          <div className="grid grid-cols-2 gap-x-3">
            {[...live.corridors].sort((a, b) => (a.status === 'Good' ? 1 : 0) - (b.status === 'Good' ? 1 : 0)).slice(0, 12).map((c) => (
              <div key={c.name} className="flex items-center gap-1.5 py-0.5 text-[11.5px]" title={c.description}>
                <span className="size-2 rounded-full" style={{ background: TFL_STATUS_COLOR[c.status] ?? '#64748b' }} />
                <span className="truncate text-ink-200">{c.name}</span>
                <span className="ml-auto text-[10px] text-ink-400">{t(c.status)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      {(!live || !live.segments) && showSim && (
        <Section title="Busiest districts (simulated distribution)">
          {top.map((z) => (
            <button key={z.id} onClick={() => { select({ kind: 'zone', zoneId: z.id }); flyTo({ lon: z.center[0], lat: z.center[1], zoom: 13 }); }} className="flex w-full items-center gap-2 rounded px-1 py-1 hover:bg-ink-800">
              <span className="truncate text-ink-200">{z.name}</span>
              <span className="ml-auto h-1.5 w-20 shrink-0 overflow-hidden rounded bg-ink-700"><span className="block h-full" style={{ width: `${z.trafficIndex}%`, background: congestionBand(z.trafficIndex).color }} /></span>
              <span className="num w-6 text-right text-ink-100">{z.trafficIndex}</span>
            </button>
          ))}
        </Section>
      )}
      <Section title={`${t(live ? 'Live disruptions' : 'Closures & incidents (simulated)')} (${incidentList.length})`}>
        {incidentList.length === 0 && <p className="text-ink-400">{t(live ? 'This feed publishes no incident data.' : 'None.')}</p>}
        {incidentList.slice(0, showAllIncidents ? 60 : 6).map((i) => (
          <button key={i.id} onClick={() => { select({ kind: 'incident', incidentId: i.id }); flyTo({ lon: i.lon, lat: i.lat, zoom: 16 }); }} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-ink-800">
            <span className={`size-2 shrink-0 rounded-full ${i.kind === 'closure' ? 'bg-red-500' : 'bg-orange-400'}`} />
            <span className="truncate text-ink-200">{t(i.title)}</span>
            {i.severity && <span className="shrink-0 text-[10px] text-ink-400">{t(i.severity)}</span>}
            <MapPinned className="ml-auto size-3.5 shrink-0 text-ink-400" />
          </button>
        ))}
        {incidentList.length > 6 && (
          <button onClick={() => setShowAllIncidents((v) => !v)} className="mt-1 text-[11px] text-accent hover:underline">{showAllIncidents ? t('Show fewer') : t('Show all {n}', { n: incidentList.length })}</button>
        )}
      </Section>
    </>
  );

  return (
    <FloatingPanel title="Traffic Intelligence" source={trafficProvenance}>
      {banner}
      {live ? body : <SimGate>{body}</SimGate>}
    </FloatingPanel>
  );
}

// ------------------------------------------------------------------ environment

const SOURCE_DOT: Record<string, string> = { ok: 'bg-emerald-400', error: 'bg-red-500', offline: 'bg-ink-500', empty: 'bg-ink-500' };

function GroundStationsSection() {
  const { stations, ground, air } = useCity();
  const select = useAppStore((s) => s.select);
  const flyTo = useAppStore((s) => s.flyTo);
  const list = stations.data?.stations ?? [];
  const ranked = [...list].filter((s) => s.grade === 'reference' || list.every((x) => x.grade !== 'reference')).sort((a, b) => (b.values.pm10 ?? b.values.pm25 ?? 0) - (a.values.pm10 ?? a.values.pm25 ?? 0));
  // Measured network median vs model at the centre, per hour.
  const hist = stations.data?.history ?? [];
  const modelByHour = new Map((air.data?.history ?? []).map((p) => [p.time.slice(0, 13), p.pm10]));
  const compare = hist.slice(-48).map((p) => ({ time: p.time, measured: p.pm10, model: modelByHour.get(p.time.slice(0, 13)) ?? null }));
  return (
    <Section title="Ground monitoring stations (measured)">
      {stations.isLoading && <Loading label="Connecting to station networks…" />}
      {stations.data && (
        <ul className="mb-2 space-y-0.5">
          {stations.data.sources.map((s) => (
            <li key={s.id} className="flex items-start gap-1.5 text-[11px]" title={t(s.detail)}>
              <span className={`mt-1 size-1.5 shrink-0 rounded-full ${SOURCE_DOT[s.state]}`} />
              <span className="text-ink-200">{t(s.label)}</span>
              <span className="ml-auto truncate pl-2 text-right text-ink-400">{t(s.detail)}</span>
            </li>
          ))}
        </ul>
      )}
      {ground.count > 0 && (
        <>
          <div className="grid grid-cols-3 gap-1.5 text-center">
            {(['pm25', 'pm10', 'no2'] as const).map((k) => (
              <div key={k} className="rounded bg-ink-800 px-1 py-1.5">
                <div className="num text-base text-ink-100">{fmt(ground[k].value)}</div>
                <div className="text-[9.5px] tracking-wide text-ink-400 uppercase">{k === 'pm25' ? 'PM2.5' : k === 'pm10' ? 'PM10' : 'NO₂'} · n={ground[k].n}</div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[10.5px] text-ink-400">{t('Medians in µg/m³')} · {t(ground.pm10.grade === 'reference' || ground.pm25.grade === 'reference' ? 'reference monitors' : 'low-cost sensors only (indicative)')}</p>
          {compare.length > 6 && (
            <div className="mt-2">
              <div className="mb-1 text-[10.5px] text-ink-400">{t('PM10: measured network median vs CAMS model')}</div>
              <TimeChart data={compare} height={120} multiDay refLine={{ y: WHO.pm10_24h, label: 'WHO' }} series={[{ key: 'measured', label: 'Measured', unit: 'µg/m³', color: '#22c55e' }, { key: 'model', label: 'Model', unit: 'µg/m³', color: '#5c7096', dashed: true }]} />
            </div>
          )}
          <div className="mt-2">
            {ranked.slice(0, 5).map((s) => (
              <button key={s.id} onClick={() => { select({ kind: 'station', stationId: s.id }); flyTo({ lon: s.lon, lat: s.lat, zoom: 14 }); }} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-ink-800">
                <span className="truncate text-ink-200">{s.name}</span>
                <span className="num ml-auto shrink-0 text-ink-100">{s.values.pm10 != null ? `PM10 ${fmt(s.values.pm10)}` : `PM2.5 ${fmt(s.values.pm25)}`}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {stations.data && ground.count === 0 && <p className="text-[11px] text-ink-400">{t('No ground stations are reporting for this city right now; values below are model data.')}</p>}
    </Section>
  );
}

function EnvironmentPanel() {
  const { air, airGrid, zones } = useCity();
  const interp = airGrid.data ? interpolateAir(zones, airGrid.data) : {};
  const ranked = [...zones].filter((z) => interp[z.id]?.pm25 != null).sort((a, b) => (interp[b.id].pm25 ?? 0) - (interp[a.id].pm25 ?? 0));
  return (
    <FloatingPanel title="Environmental Monitoring" source={AIR_PROVENANCE}>
      <GroundStationsSection />
      <Section title="Anomalies in measured readings (ML estimate)">
        <AnomalyList limit={5} dense />
      </Section>
      <div className="mt-3 mb-1 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">{t('Regional model (CAMS)')}</div>
      {air.isLoading && <Loading />}
      {air.isError && <ErrorState error={air.error} onRetry={() => air.refetch()} />}
      {air.data && (
        <>
          <div className="flex items-baseline gap-2">
            <span className="num text-3xl font-semibold" style={{ color: aqiBand(air.data.aqi.value).color }}>{fmtInt(air.data.aqi.value)}</span>
            <span className="text-ink-300">{t('European AQI')} · {aqiBand(air.data.aqi.value).label}</span>
          </div>
          <p className="mt-1 text-[11px] text-ink-400">{t('Model time')} {new Date(air.data.aqi.timestamp).toLocaleString(locale())}</p>
          <Section title="Pollutants (city centre)">
            <KV k="PM2.5" v={`${fmt(air.data.pm25.value)} µg/m³`} />
            <KV k="PM10" v={`${fmt(air.data.pm10.value)} µg/m³`} />
            <KV k="NO₂" v={`${fmt(air.data.no2.value)} µg/m³`} />
            <KV k="O₃" v={`${fmt(air.data.ozone.value)} µg/m³`} />
            <KV k="CO" v={`${fmtInt(air.data.co.value)} µg/m³`} />
            <KV k="CO₂" v={`${fmtInt(air.data.co2.value)} ppm`} />
          </Section>
          <Section title="PM2.5 · 72 h">
            <TimeChart data={air.data.history} height={120} multiDay refLine={{ y: WHO.pm25_24h, label: 'WHO' }} series={[{ key: 'pm25', label: 'PM2.5', unit: 'µg/m³' }]} />
          </Section>
        </>
      )}
      <Section title="Zones by PM2.5 (interpolated)">
        <div className="mb-1"><SourceBadge p={AIR_INTERP_PROVENANCE} /></div>
        {airGrid.isLoading && <Loading label="Sampling model grid…" />}
        {airGrid.isError && <ErrorState error={airGrid.error} onRetry={() => airGrid.refetch()} />}
        {ranked.slice(0, 6).map((z) => (
          <KV key={z.id} k={z.name} v={`${fmt(interp[z.id].pm25)} µg/m³`} />
        ))}
      </Section>
      <Section title="Noise (estimated)">
        <div className="mb-1"><SourceBadge p={NOISE_PROVENANCE} /></div>
        <SimGate compact>
          {[...zones].sort((a, b) => b.trafficIndex - a.trafficIndex).slice(0, 3).map((z) => (
            <KV key={z.id} k={z.name} v={`${fmt(estimateNoiseDb(z.trafficIndex))} dB(A)`} />
          ))}
        </SimGate>
      </Section>
    </FloatingPanel>
  );
}

// ------------------------------------------------------------------ energy

function EnergyPanel() {
  const { zones, energyHistory } = useCity();
  const select = useAppStore((s) => s.select);
  const flyTo = useAppStore((s) => s.flyTo);
  const total = zones.reduce((s, z) => s + z.energyMWh, 0);
  const anomalies = energyAnomalies(zones);
  const solarTop = [...zones].sort((a, b) => b.solarPotentialKWhm2 - a.solarPotentialKWhm2).slice(0, 3);
  return (
    <FloatingPanel title="Energy Intelligence" source={SIM_PROVENANCE}>
      <SimGate>
        <div className="flex items-baseline gap-2">
          <span className="num text-3xl font-semibold">{fmtInt(total)}</span>
          <span className="text-ink-300">{t('MWh/day across {n} zones', { n: zones.length })}</span>
        </div>
        <Section title="Demand & renewable share · 24 h">
          <TimeChart data={energyHistory} height={130} area series={[{ key: 'demand', label: 'Demand', unit: 'MW', color: '#3b82f6' }, { key: 'renewable', label: 'Solar (est.)', unit: 'MW', color: '#f59e0b' }]} />
        </Section>
        <Section title={t('Unusually high consumption ({n})', { n: anomalies.length })}>
          {anomalies.length === 0 && <p className="text-ink-400">{t('No zone exceeds its baseline by more than 20%.')}</p>}
          {anomalies.map((z) => (
            <button key={z.id} onClick={() => { select({ kind: 'zone', zoneId: z.id }); flyTo({ lon: z.center[0], lat: z.center[1], zoom: 15 }); }} className="flex w-full items-center gap-2 rounded px-1 py-1 hover:bg-ink-800">
              <span className="text-ink-200">{z.name}</span>
              <span className="num ml-auto text-orange-400">+{fmt(pctOver(z))}%</span>
            </button>
          ))}
        </Section>
        <Section title="Rooftop solar potential">
          <div className="mb-1"><SourceBadge p={SOLAR_PROVENANCE} /></div>
          {solarTop.map((z) => (
            <KV key={z.id} k={z.name} v={`${fmtInt(z.solarPotentialKWhm2)} ${t('kWh/m²·yr')}`} />
          ))}
        </Section>
      </SimGate>
    </FloatingPanel>
  );
}
