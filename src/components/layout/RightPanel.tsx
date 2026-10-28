import { Building2, Car, Hexagon, MapPin, Radio, Sparkles, TriangleAlert, X } from 'lucide-react';
import { PROVIDER_PROVENANCE, type Pollutant } from '../../services/air/stations';
import { useCity } from '../../hooks/CityDataContext';
import { pointInPolyGeom } from '../../services/osm/geometry';
import { osmIdFromTileId, USE_CATEGORIES } from '../../services/osm/buildings';
import { useOsmStore } from '../../store/useOsmStore';
import { aqiBand, congestionBand, fmt, fmtInt, weatherCodeLabel } from '../../lib/format';
import { ENGINE_PROVENANCE, energyAnomalies, pctOver } from '../../services/analysis';
import { estimateNoiseDb, NOISE_PROVENANCE, SIM_PROVENANCE } from '../../services/simulated';
import { useAppStore } from '../../store/useAppStore';
import type { Provenance, Selection, Zone } from '../../types/data';
import { ErrorState, KV, Loading, Panel, SimGate } from '../ui/Panel';
import { SourceBadge } from '../ui/SourceBadge';
import { useTemp } from '../../hooks/useTemp';
import { t, locale } from '../../i18n';

const OSM: Provenance = { source: 'external-api', provider: 'OpenStreetMap (OpenFreeMap tiles)' };
const BUILDING_EST: Provenance = {
  source: 'estimated',
  provider: 'CityTwin building model',
  note: 'Floors ≈ height / 3.2 m. Energy ≈ floor area × 150 kWh/m²·yr (typical mixed-use intensity). Replace with metered data when available.',
};

export function RightPanel() {
  const open = useAppStore((s) => s.rightPanelOpen);
  if (!open) return null;
  return (
    <aside className="no-print hidden w-72 shrink-0 flex-col gap-2 overflow-y-auto border-l border-ink-700 bg-ink-900 p-2 md:flex xl:w-80">
      <SelectionCard />
      <EnvironmentCard />
      <TrafficCard />
      <EnergyCard />
      <InsightsCard />
    </aside>
  );
}

export function zoneAt(zones: Zone[], lon: number, lat: number) {
  return zones.find((z) => pointInPolyGeom([lon, lat], z.geometry));
}

function SelectionCard() {
  const selection = useAppStore((s) => s.selection);
  const select = useAppStore((s) => s.select);
  const { zones } = useCity();
  return (
    <Panel
      title="Selection"
      actions={selection && (
        <button onClick={() => select(null)} className="text-ink-400 hover:text-ink-100" aria-label={t('Clear selection')}>
          <X className="size-3.5" />
        </button>
      )}
    >
      {selection ? <SelectionBody s={selection} zones={zones} /> : (
        <p className="text-ink-400">{t('Click a building, road or zone on the map to inspect it. Search a place from the top bar to jump to it.')}</p>
      )}
    </Panel>
  );
}

function SelectionBody({ s, zones }: { s: NonNullable<Selection>; zones: Zone[] }) {
  if (s.kind === 'zone') {
    const z = zones.find((x) => x.id === s.zoneId);
    if (!z) return <p className="text-ink-400">{t('Zone not found in the current city.')}</p>;
    return <ZoneDetails z={z} />;
  }
  if (s.kind === 'station') return <StationDetails id={s.stationId} />;
  if (s.kind === 'incident') return <IncidentDetails id={s.incidentId} />;
  const zone = zoneAt(zones, s.lon, s.lat);
  const coords = `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`;
  if (s.kind === 'building') return <BuildingDetails s={s} zone={zone} coords={coords} />;
  if (s.kind === 'road' && s.props.source) {
    // Real segment from a live feed (NYC DOT speeds or TfL disruption streets).
    const live: Provenance = { source: s.props.source === 'NYC DOT' ? 'sensor' : 'external-api', provider: String(s.props.source) };
    const band = congestionBand(Math.max(0, s.congestion));
    return (
      <div>
        <Title icon={<Car className="size-4" />} title={String(s.props.name ?? 'Road segment')} sub={coords} />
        {s.props.speedMph != null && <KV k="Measured speed" v={`${fmt(Number(s.props.speedMph))} mph · ${fmtInt(Number(s.props.speedMph) * 1.609)} km/h`} source={live} />}
        {s.props.measuredAt ? <KV k="Measured at" v={new Date(String(s.props.measuredAt)).toLocaleTimeString(locale())} source={live} /> : null}
        {s.props.severity ? <KV k="Disruption severity" v={String(s.props.severity)} source={live} /> : null}
        {s.props.closure ? <KV k="Closure" v={String(s.props.closure)} source={live} /> : null}
        {s.congestion >= 0 && (
          <KV k="Congestion" v={<span style={{ color: band.color }}>{s.congestion}% · {band.label}</span>} source={{ source: 'estimated', provider: 'CityTwin', note: s.props.speedMph != null ? 'Derived: 1 − speed / link’s 24 h 90th-percentile speed.' : 'Mapped from disruption severity.' }} />
        )}
        {s.props.borough ? <KV k="Borough" v={String(s.props.borough)} /> : null}
        {zone && <KV k="District" v={zone.name} />}
      </div>
    );
  }
  if (s.kind === 'road') {
    const band = congestionBand(s.congestion);
    const freeFlow = FREE_FLOW[String(s.props.class)] ?? 30;
    return (
      <div>
        <Title icon={<Car className="size-4" />} title={`${t('Road')} · ${t(String(s.props.class ?? 'unknown'))}`} sub={coords} />
        {s.props.subclass ? <KV k="Subclass" v={String(s.props.subclass)} source={OSM} /> : null}
        {s.props.oneway ? <KV k="One-way" v="yes" source={OSM} /> : null}
        {s.props.brunnel ? <KV k="Structure" v={String(s.props.brunnel)} source={OSM} /> : null}
        <SimGate compact>
          <KV k="Congestion" v={<span style={{ color: band.color }}>{s.congestion}/100 · {band.label}</span>} source={SIM_PROVENANCE} />
          <KV k="Speed (est.)" v={`${fmtInt(freeFlow * (1 - 0.7 * (s.congestion / 100)))} km/h`} source={SIM_PROVENANCE} />
        </SimGate>
        {zone && <KV k="District" v={zone.name} />}
      </div>
    );
  }
  return (
    <div>
      <Title icon={<MapPin className="size-4" />} title="Place" sub={coords} />
      <p className="text-ink-200">{s.label}</p>
      {zone ? <ZoneDetails z={zone} compact /> : <p className="mt-2 text-[11px] text-ink-400">{t('Outside the analysed districts for this city.')}</p>}
    </div>
  );
}

const FREE_FLOW: Record<string, number> = { motorway: 100, trunk: 80, primary: 60, secondary: 50, tertiary: 40, minor: 30, service: 20 };

const POLLUTANT_LABEL: Record<Pollutant, string> = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂', o3: 'O₃', so2: 'SO₂', co: 'CO' };

function StationDetails({ id }: { id: string }) {
  const { stations } = useCity();
  const st = stations.data?.stations.find((x) => x.id === id);
  if (!st) return <p className="text-ink-400">{t('Station no longer reporting.')}</p>;
  const p = PROVIDER_PROVENANCE[st.provider];
  return (
    <div>
      <Title icon={<Radio className="size-4" />} title={st.name} sub={`${st.lat.toFixed(5)}, ${st.lon.toFixed(5)}`} />
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <SourceBadge p={p} />
        <span className={`rounded px-1.5 py-px text-[9.5px] font-semibold tracking-wider uppercase ${st.grade === 'reference' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{t(st.grade)}</span>
      </div>
      {(Object.keys(POLLUTANT_LABEL) as Pollutant[]).filter((k) => st.values[k] != null).map((k) => (
        <KV key={k} k={POLLUTANT_LABEL[k]} v={`${fmt(st.values[k]!)} µg/m³`} />
      ))}
      <KV k="Measured" v={st.measuredAt ? new Date(st.measuredAt).toLocaleString(locale()) : '—'} />
      {st.grade === 'low-cost' && <p className="mt-2 text-[11px] text-amber-300/80">{t('Low-cost optical sensor: indicative only, can over-read in fog or high humidity.')}</p>}
    </div>
  );
}

function IncidentDetails({ id }: { id: string }) {
  const { incidents, trafficProvenance } = useCity();
  const i = incidents.find((x) => x.id === id);
  if (!i) return <p className="text-ink-400">{t('Incident has cleared.')}</p>;
  return (
    <div>
      <Title icon={<TriangleAlert className="size-4" />} title={i.title} sub={`${i.lat.toFixed(5)}, ${i.lon.toFixed(5)}`} />
      <div className="mb-1"><SourceBadge p={i.live ? trafficProvenance : SIM_PROVENANCE} /></div>
      {i.severity && <KV k="Severity" v={i.severity} />}
      <KV k="Type" v={t(i.kind)} />
      {i.detail && <p className="mt-1.5 text-[11.5px] text-ink-300">{t(i.detail)}</p>}
    </div>
  );
}

const OSM_ATTR: Provenance = { source: 'external-api', provider: 'OpenStreetMap tags (imported)' };

function BuildingDetails({ s, zone, coords }: { s: Extract<NonNullable<Selection>, { kind: 'building' }>; zone?: Zone; coords: string }) {
  const record = useOsmStore((st) => st.buildings.get(osmIdFromTileId(Number(s.props.__tileId))));
  const h = Number(s.props.render_height ?? 0);
  const minH = Number(s.props.render_min_height ?? 0);
  const area = record?.footprintM2 || Number(s.props.__areaM2 ?? 0);
  const floors = record?.levels ?? Math.max(1, Math.round((h - minH) / 3.2));
  const floorsSource = record?.levels != null ? OSM_ATTR : BUILDING_EST;
  const gfa = area * floors;
  const cat = record ? USE_CATEGORIES.find((c) => c.id === record.category) : null;
  return (
    <div>
      <Title icon={<Building2 className="size-4" />} title={record?.name ?? 'Building'} sub={coords} />
      {record ? (
        <>
          <KV k="Use" v={<span style={{ color: cat?.color }}>{t(cat?.label ?? '')}</span>} source={OSM_ATTR} />
          <KV k="building=" v={record.buildingTag} source={OSM_ATTR} />
          {record.amenity && <KV k="Function" v={record.amenity} source={OSM_ATTR} />}
          {record.address && <KV k="Address" v={<span className="font-sans">{record.address}</span>} source={OSM_ATTR} />}
          {record.startDate && <KV k="Built" v={record.startDate} source={OSM_ATTR} />}
          {record.roofShape && <KV k="Roof" v={record.roofShape} source={OSM_ATTR} />}
          {record.material && <KV k="Material" v={record.material} source={OSM_ATTR} />}
          {record.heightM != null && <KV k="Height (tagged)" v={`${fmt(record.heightM)} m`} source={OSM_ATTR} />}
        </>
      ) : (
        <p className="mb-1 text-[11px] text-ink-400">{t('No imported OSM attributes for this building. Use “Import OSM data for view” in the 3D City panel.')}</p>
      )}
      <KV k="Rendered height" v={h ? `${fmt(h)} m` : 'not mapped'} source={OSM} />
      {minH > 0 && <KV k="Base height" v={`${fmt(minH)} m`} source={OSM} />}
      <KV k="Footprint" v={area ? `${fmtInt(area)} m²` : '—'} source={record ? OSM_ATTR : BUILDING_EST} />
      <KV k={record?.levels != null ? 'Levels' : 'Floors (est.)'} v={floors} source={floorsSource} />
      <KV k="Floor area (est.)" v={gfa ? `${fmtInt(gfa)} m²` : '—'} source={BUILDING_EST} />
      <KV k="Energy (est.)" v={gfa ? `${fmt((gfa * 150) / 1000, 0)} MWh/yr` : '—'} source={BUILDING_EST} />
      {zone && <KV k="District" v={zone.name} />}
      {record && (
        <a href={`https://www.openstreetmap.org/${record.osmType}/${record.osmId}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[11px] text-accent hover:underline">
          {t('View {type} {id} on openstreetmap.org ↗', { type: record.osmType, id: record.osmId })}
        </a>
      )}
    </div>
  );
}

const ZONE_GEOM: Provenance = { source: 'external-api', provider: 'OpenStreetMap boundary' };

function ZoneDetails({ z, compact = false }: { z: Zone; compact?: boolean }) {
  const kind = t(z.kind === 'district' ? 'District' : 'Grid zone');
  const popSource: Provenance = z.populationSource === 'osm' ? { source: 'external-api', provider: 'OpenStreetMap population tag' } : SIM_PROVENANCE;
  return (
    <div className={compact ? 'mt-2 border-t border-ink-700 pt-2' : ''}>
      {!compact && <Title icon={<Hexagon className="size-4" />} title={`${kind} · ${z.name}`} sub={`${z.center[1].toFixed(4)}, ${z.center[0].toFixed(4)}`} />}
      {compact && <div className="mb-1 text-[11px] font-semibold tracking-wider text-ink-300 uppercase">{kind} {z.name}</div>}
      <KV k="Area" v={`${fmt(z.areaKm2)} km²`} source={z.kind === 'district' ? ZONE_GEOM : undefined} />
      {z.populationSource === 'osm' && <KV k="Population" v={fmtInt(z.population)} source={popSource} />}
      <SimGate compact>
        {z.populationSource === 'simulated' && <KV k="Population" v={fmtInt(z.population)} source={popSource} />}
        <KV k="Traffic index" v={`${z.trafficIndex}/100`} source={SIM_PROVENANCE} />
        <KV k="Energy" v={`${fmt(z.energyMWh)} MWh/d`} source={SIM_PROVENANCE} />
        <KV k="vs baseline" v={`${pctOver(z) >= 0 ? '+' : ''}${fmt(pctOver(z))}%`} source={SIM_PROVENANCE} />
        <KV k="Green share" v={`${fmtInt(z.greenShare * 100)}%`} source={SIM_PROVENANCE} />
        <KV k="Noise (est.)" v={`${fmt(estimateNoiseDb(z.trafficIndex))} dB(A)`} source={NOISE_PROVENANCE} />
      </SimGate>
      {z.osmId && !compact && (
        <a href={`https://www.openstreetmap.org/relation/${z.osmId}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[11px] text-accent hover:underline">
          {t('View relation {id} on openstreetmap.org ↗', { id: z.osmId })}
        </a>
      )}
    </div>
  );
}

function Title({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="flex size-7 items-center justify-center rounded bg-ink-700 text-accent">{icon}</span>
      <div className="min-w-0">
        <div className="truncate font-medium capitalize">{t(title)}</div>
        <div className="num text-[10.5px] text-ink-400">{sub}</div>
      </div>
    </div>
  );
}

function EnvironmentCard() {
  const { weather, air } = useCity();
  const temp = useTemp();
  return (
    <Panel title="Environment">
      {weather.isLoading && <Loading />}
      {weather.isError && <ErrorState error={weather.error} onRetry={() => weather.refetch()} />}
      {weather.data && (
        <>
          <div className="mb-1 flex items-center gap-2">
            <span className="num text-2xl font-semibold">{temp.fmt(weather.data.temperature.value)}</span>
            <span className="text-ink-300">{weatherCodeLabel(weather.data.weatherCode)}</span>
            <span className="ml-auto"><SourceBadge p={weather.data.temperature} compact /></span>
          </div>
          <KV k="Feels like" v={temp.fmt(weather.data.apparentTemperature.value)} />
          <KV k="Humidity" v={`${fmtInt(weather.data.humidity.value)} %`} />
          <KV k="Wind" v={`${fmt(weather.data.windSpeed.value)} km/h`} />
        </>
      )}
      <div className="my-2 border-t border-ink-700" />
      <GroundAir />
      {air.isLoading && <Loading />}
      {air.isError && <ErrorState error={air.error} onRetry={() => air.refetch()} />}
      {air.data && (
        <>
          <div className="mb-0.5 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">{t('Regional model')}</div>
          <div className="flex items-center gap-2">
            <span className="text-ink-300">{t('European AQI')}</span>
            <span className="num ml-auto font-semibold" style={{ color: aqiBand(air.data.aqi.value).color }}>
              {fmtInt(air.data.aqi.value)} · {aqiBand(air.data.aqi.value).label}
            </span>
            <SourceBadge p={air.data.aqi} compact />
          </div>
          <KV k="PM2.5" v={`${fmt(air.data.pm25.value)} µg/m³`} />
          <KV k="PM10" v={`${fmt(air.data.pm10.value)} µg/m³`} />
          <KV k="NO₂" v={`${fmt(air.data.no2.value)} µg/m³`} />
        </>
      )}
    </Panel>
  );
}

/** Ground-station medians — real measurements, shown above the regional model. */
function GroundAir() {
  const { stations, ground } = useCity();
  if (stations.isLoading) return <Loading label="Connecting to ground stations…" />;
  if (!ground.count) {
    return <p className="mb-2 text-[11px] text-ink-400">{t('No ground stations reporting for this city — showing model data only.')} {stations.data?.sources.find((s) => s.id === 'openaq')?.state === 'offline' ? t('Adding an OpenAQ key extends coverage.') : ''}</p>;
  }
  const prov: Provenance = { source: 'sensor', provider: t('{n} ground stations', { n: ground.count }), note: 'Median of latest readings; reference monitors preferred over low-cost sensors.' };
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center gap-2 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">
        {t('Measured at ground level')}
        <span className="ml-auto"><SourceBadge p={prov} compact /></span>
      </div>
      {ground.pm25.value != null && <KV k={`PM2.5 · ${ground.pm25.n} ${t(ground.pm25.grade)}`} v={`${fmt(ground.pm25.value)} µg/m³`} />}
      {ground.pm10.value != null && <KV k={`PM10 · ${ground.pm10.n} ${t(ground.pm10.grade)}`} v={`${fmt(ground.pm10.value)} µg/m³`} />}
      {ground.no2.value != null && <KV k={`NO₂ · ${ground.no2.n} ${t(ground.no2.grade)}`} v={`${fmt(ground.no2.value)} µg/m³`} />}
    </div>
  );
}

function TrafficCard() {
  const { congestionNow, zones, incidents, liveTraffic, trafficProvenance } = useCity();
  const live = liveTraffic.data;
  const band = congestionBand(congestionNow);
  const worst = [...zones].sort((a, b) => b.trafficIndex - a.trafficIndex)[0];
  const body = (
    <>
      <div className="flex items-baseline gap-2">
        <span className="num text-2xl font-semibold" style={{ color: band.color }}>{congestionNow}</span>
        <span className="text-ink-300">/100 · {band.label}</span>
      </div>
      {live && <div className="text-[11px] text-ink-400">{t(live.indexLabel)}{live.asOf ? ` · ${new Date(live.asOf).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}` : ''}{live.stale ? ` · ${t('delayed')}` : ''}</div>}
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-ink-700">
        <div className="h-full rounded transition-all" style={{ width: `${congestionNow}%`, background: band.color }} />
      </div>
      {live?.subIndices.map((s) => <KV key={s.label} k={s.label} v={s.value} />)}
      {!live && <KV k="Most congested zone" v={worst ? `${worst.name} (${worst.trafficIndex})` : '—'} />}
      <KV k={live ? 'Live incidents' : 'Active incidents'} v={incidents.length} />
    </>
  );
  return (
    <Panel title="Traffic status" source={trafficProvenance}>
      {liveTraffic.isError && <p className="mb-1 text-[11px] text-amber-300">{t('Live feed unavailable ({err}) — showing simulation.', { err: (liveTraffic.error as Error).message })}</p>}
      {live ? body : <SimGate>{body}</SimGate>}
    </Panel>
  );
}

function EnergyCard() {
  const { zones } = useCity();
  const total = zones.reduce((s, z) => s + z.energyMWh, 0);
  const base = zones.reduce((s, z) => s + z.energyBaselineMWh, 0);
  const anomalies = energyAnomalies(zones);
  return (
    <Panel title="Energy" source={SIM_PROVENANCE}>
      <SimGate>
        <div className="flex items-baseline gap-2">
          <span className="num text-2xl font-semibold">{fmtInt(total)}</span>
          <span className="text-ink-300">{t('MWh / day')}</span>
        </div>
        <KV k="vs baseline" v={`${total >= base ? '+' : ''}${fmt((total / base - 1) * 100)}%`} />
        <KV k="High-use zones" v={anomalies.length ? anomalies.map((z) => z.name).join(', ') : t('none')} />
      </SimGate>
    </Panel>
  );
}

function InsightsCard() {
  const { insights } = useCity();
  const showSim = useAppStore((s) => s.settings.showSimulated);
  const list = insights.filter((i) => showSim || i.source !== 'simulated');
  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><Sparkles className="size-3.5 text-accent" /> {t('Insights')}</span>} source={ENGINE_PROVENANCE}>
      {list.length === 0 ? (
        <p className="text-ink-400">{t('Waiting for data…')}</p>
      ) : (
        <ul className="space-y-2">
          {list.map((i) => (
            <li key={i.id} className="flex gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
              <div className="min-w-0">
                <p className="text-ink-200">{t(i.text)}</p>
                <SourceBadge p={i} compact />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
