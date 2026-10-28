import { AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import { CityMap } from '../components/map/CityMap';
import { HBarChart, TimeChart } from '../components/charts/Charts';
import { ErrorState, Loading, Panel, SimGate, Stat } from '../components/ui/Panel';
import { SourceBadge, SourceLegend } from '../components/ui/SourceBadge';
import { useCity } from '../hooks/CityDataContext';
import { useTemp } from '../hooks/useTemp';
import { aqiBand, congestionBand, fmt, fmtInt } from '../lib/format';
import { AIR_INTERP_PROVENANCE, interpolateAir, pctOver, WHO } from '../services/analysis';
import { AIR_PROVENANCE, WEATHER_PROVENANCE } from '../services/openMeteo';
import { estimateNoiseDb, NOISE_PROVENANCE, SIM_PROVENANCE } from '../services/simulated';
import { DISTRICT_PROVENANCE } from '../services/districts';
import { ANOMALY_PROVENANCE } from '../services/anomalies';
import { AnomalyList } from '../components/AnomalyList';
import { useAppStore } from '../store/useAppStore';
import type { AlertSeverity, CityAlert } from '../types/data';
import { t, locale } from '../i18n';

const MINI_LAYERS = { buildings: true, air: true, zones: true, green: true, transit: false } as const;

export function OverviewPage() {
  const d = useCity();
  const temp = useTemp();
  const setPage = useAppStore((s) => s.setPage);
  const select = useAppStore((s) => s.select);
  const totalEnergy = d.zones.reduce((s, z) => s + z.energyMWh, 0);
  const aqi = d.air.data?.aqi.value ?? null;
  const band = congestionBand(d.congestionNow);
  const avgNoise = d.zones.reduce((s, z) => s + estimateNoiseDb(z.trafficIndex), 0) / d.zones.length;
  const air = d.airGrid.data ? interpolateAir(d.zones, d.airGrid.data) : {};

  const tempHistory = d.weather.data?.history.map((p) => ({ ...p, temperature: temp.conv(p.temperature as number | null) })) ?? [];

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-lg font-semibold">{t('{city} · City Overview', { city: d.city.name })}</h1>
          <p className="text-ink-400">{t('Monitoring {area} km²', { area: fmt(d.areaKm2, 0) })} · {d.zones.length} {t(d.zones[0]?.kind === 'district' ? 'OSM districts' : 'grid zones (no district import)')}</p>
        </div>
        <div className="ml-auto"><SourceLegend /></div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Monitored area" value={fmt(d.areaKm2, 0)} unit="km²" sub={`${d.zones.length} ${t(d.zones[0]?.kind === 'district' ? 'OSM districts' : 'hex zones')}`} source={d.zones[0]?.kind === 'district' ? DISTRICT_PROVENANCE : undefined} />
        <Stat
          label="Ground stations"
          value={d.stations.isLoading ? '…' : d.ground.count}
          sub={d.ground.count ? `PM10 ${fmt(d.ground.pm10.value)} · PM2.5 ${fmt(d.ground.pm25.value)} µg/m³` : 'none reporting — model only'}
          source={{ source: 'sensor', provider: 'Ground monitoring stations', note: 'Reporting reference monitors and low-cost sensors (median shown).' }}
        />
        <Stat label="Air quality (EAQI)" value={d.air.isLoading ? '…' : fmtInt(aqi)} sub={aqiBand(aqi).label} accent={aqiBand(aqi).color} source={AIR_PROVENANCE} />
        <Stat label="Temperature" value={d.weather.isLoading ? '…' : fmt(temp.conv(d.weather.data?.temperature.value), 1)} unit={`°${temp.unit}`} sub={`${t('Humidity')} ${fmtInt(d.weather.data?.humidity.value)}%`} source={WEATHER_PROVENANCE} />
        <Stat label={d.liveTraffic.data ? d.liveTraffic.data.indexLabel : 'Congestion index'} value={d.congestionNow} unit="/100" sub={band.label} accent={band.color} source={d.trafficProvenance} />
        <Stat label="Energy (daily)" value={fmtInt(totalEnergy)} unit="MWh" sub="all zones" source={SIM_PROVENANCE} />
        <Stat label="Noise (avg)" value={fmt(avgNoise)} unit="dB(A)" sub="from traffic model" source={NOISE_PROVENANCE} />
        <Stat label="Active alerts" value={d.alerts.length} sub={t('{n} critical', { n: d.alerts.filter((a) => a.severity === 'critical').length })} accent={d.alerts.some((a) => a.severity !== 'info') ? '#f97316' : undefined} />
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 xl:grid-cols-3">
        <Panel title="Temperature & humidity · 48 h" source={WEATHER_PROVENANCE} className="xl:col-span-1">
          {d.weather.isLoading ? <Loading /> : d.weather.isError ? <ErrorState error={d.weather.error} onRetry={() => d.weather.refetch()} /> : (
            <TimeChart
              data={tempHistory}
              multiDay
              series={[
                { key: 'temperature', label: 'Temperature', unit: `°${temp.unit}`, color: '#f59e0b' },
                { key: 'humidity', label: 'Humidity', unit: '%', color: '#3b82f6', dashed: true, right: true },
              ]}
            />
          )}
        </Panel>
        <Panel title="Particulates & NO₂ · 72 h" source={AIR_PROVENANCE}>
          {d.air.isLoading ? <Loading /> : d.air.isError ? <ErrorState error={d.air.error} onRetry={() => d.air.refetch()} /> : (
            <TimeChart
              data={d.air.data!.history}
              multiDay
              refLine={{ y: WHO.pm25_24h, label: 'WHO PM2.5' }}
              series={[
                { key: 'pm25', label: 'PM2.5', unit: 'µg/m³', color: '#22d3ee' },
                { key: 'pm10', label: 'PM10', unit: 'µg/m³', color: '#a78bfa' },
                { key: 'no2', label: 'NO₂', unit: 'µg/m³', color: '#f43f5e', dashed: true },
              ]}
            />
          )}
        </Panel>
        <Panel title={`${t('Congestion · today vs last week')}${d.liveTraffic.data && !d.liveTraffic.data.history ? ` (${t('simulated')})` : ''}`} source={d.liveTraffic.data?.history ? d.trafficProvenance : SIM_PROVENANCE}>
          <SimGate force={!!d.liveTraffic.data?.history}>
            <TimeChart
              data={d.trafficHistory}
              area
              yDomain={[0, 100]}
              series={[
                { key: 'today', label: 'Last 24 h', color: '#22d3ee' },
                { key: 'lastWeek', label: 'Same hours, last week', color: '#5c7096', dashed: true },
              ]}
            />
          </SimGate>
        </Panel>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 xl:grid-cols-3">
        <Panel
          title="Air quality map"
          source={AIR_INTERP_PROVENANCE}
          bodyClassName="h-72"
          actions={<button onClick={() => setPage('environment')} className="text-[11px] text-accent hover:underline">{t('Open Environment →')}</button>}
        >
          <CityMap mini miniLayers={MINI_LAYERS} />
        </Panel>
        <Panel title={t('District comparison ({n})', { n: d.zones.length })} source={SIM_PROVENANCE} className="xl:col-span-2" bodyClassName="max-h-72 overflow-auto">
          <SimGate>
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-ink-850 text-[10.5px] tracking-wider text-ink-400 uppercase">
                <tr className="border-b border-ink-700">
                  <th className="px-3 py-1.5 font-medium">{t('District')}</th>
                  <th className="px-2 py-1.5 text-right font-medium" title={t('Population: OSM tag where available, otherwise simulated')}>{t('Pop.')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('Traffic')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('Energy MWh/d')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('vs base')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('Green')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('Noise est.')}</th>
                  <th className="px-3 py-1.5 text-right font-medium" title={t('Interpolated from model grid')}>{t('PM2.5 est.')}</th>
                </tr>
              </thead>
              <tbody>
                {[...d.zones].sort((a, b) => b.trafficIndex - a.trafficIndex).map((z) => {
                  const over = pctOver(z);
                  return (
                    <tr
                      key={z.id}
                      onClick={() => { select({ kind: 'zone', zoneId: z.id }); setPage('city3d'); }}
                      className="num cursor-pointer border-b border-ink-800 hover:bg-ink-800"
                    >
                      <td className="px-3 py-1 font-sans text-ink-100">{z.name}</td>
                      <td className={`px-2 py-1 text-right ${z.populationSource === 'osm' ? 'text-src-api' : 'text-ink-300'}`} title={t(z.populationSource === 'osm' ? 'OSM population tag' : 'Simulated')}>{fmtInt(z.population)}</td>
                      <td className="px-2 py-1 text-right" style={{ color: congestionBand(z.trafficIndex).color }}>{z.trafficIndex}</td>
                      <td className="px-2 py-1 text-right">{fmt(z.energyMWh)}</td>
                      <td className={`px-2 py-1 text-right ${over > 20 ? 'text-orange-400' : 'text-ink-300'}`}>{over >= 0 ? '+' : ''}{fmt(over)}%</td>
                      <td className="px-2 py-1 text-right">{fmtInt(z.greenShare * 100)}%</td>
                      <td className="px-2 py-1 text-right">{fmt(estimateNoiseDb(z.trafficIndex))}</td>
                      <td className="px-3 py-1 text-right">{fmt(air[z.id]?.pm25)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </SimGate>
        </Panel>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Panel title={`${t('Sensor anomalies (ML)')}${d.anomalies.data ? ` · ${d.anomalies.data.anomalies.length}` : ''}`} source={ANOMALY_PROVENANCE} bodyClassName="max-h-60 overflow-auto p-0">
          <AnomalyList limit={20} />
        </Panel>
        <Panel title="Energy by zone" source={SIM_PROVENANCE}>
          <SimGate>
            <HBarChart
              data={[...d.zones].sort((a, b) => b.energyMWh - a.energyMWh).slice(0, 10).map((z) => ({ name: z.name, energy: z.energyMWh, ratio: z.energyMWh / z.energyBaselineMWh, id: z.id }))}
              labelKey="name"
              valueKey="energy"
              unit="MWh/d"
              colorFor={(r) => ((r.ratio as number) > 1.2 ? '#f97316' : '#3b82f6')}
              onSelect={(r) => select({ kind: 'zone', zoneId: String(r.id) })}
            />
          </SimGate>
        </Panel>
        <Panel title={t('Alerts ({n})', { n: d.alerts.length })} bodyClassName="max-h-60 overflow-auto p-0">
          <AlertList alerts={d.alerts} />
        </Panel>
        <Panel title="System events" bodyClassName="max-h-60 overflow-auto p-0">
          <SystemEvents />
        </Panel>
      </div>
    </div>
  );
}

const SEV: Record<AlertSeverity, { icon: typeof Info; cls: string }> = {
  critical: { icon: AlertOctagon, cls: 'text-red-400' },
  warning: { icon: AlertTriangle, cls: 'text-orange-400' },
  info: { icon: Info, cls: 'text-sky-400' },
};

export function AlertList({ alerts }: { alerts: CityAlert[] }) {
  const showSim = useAppStore((s) => s.settings.showSimulated);
  const list = alerts.filter((a) => showSim || a.source !== 'simulated');
  if (!list.length) return <p className="p-3 text-ink-400">{t('No active alerts.')}</p>;
  return (
    <ul>
      {list.map((a) => {
        const S = SEV[a.severity];
        return (
          <li key={a.id} className="flex gap-2 border-b border-ink-800 px-3 py-2">
            <S.icon className={`mt-0.5 size-4 shrink-0 ${S.cls}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-ink-100">{t(a.title)}</span>
                <span className="ml-auto text-[10px] text-ink-400 uppercase">{t(a.module)}</span>
              </div>
              <p className="text-ink-300">{t(a.detail)}</p>
              <div className="mt-1"><SourceBadge p={a} /></div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SystemEvents() {
  const { weather, air, airGrid, city } = useCity();
  const ev: { t: number; text: string; ok: boolean }[] = [];
  if (weather.dataUpdatedAt) ev.push({ t: weather.dataUpdatedAt, text: t('Weather feed refreshed for {city}', { city: city.name }), ok: true });
  if (air.dataUpdatedAt) ev.push({ t: air.dataUpdatedAt, text: t('Air quality feed refreshed ({n} hourly points)', { n: air.data?.history.length ?? 0 }), ok: true });
  if (airGrid.dataUpdatedAt) ev.push({ t: airGrid.dataUpdatedAt, text: t('Air model grid sampled ({n} points)', { n: airGrid.data?.length ?? 0 }), ok: true });
  if (weather.errorUpdatedAt) ev.push({ t: weather.errorUpdatedAt, text: `${t('Weather feed error')}: ${t(weather.error?.message ?? '')}`, ok: false });
  if (air.errorUpdatedAt) ev.push({ t: air.errorUpdatedAt, text: `${t('Air feed error')}: ${t(air.error?.message ?? '')}`, ok: false });
  ev.push({ t: performance.timeOrigin, text: t('CityTwin client session started'), ok: true });
  ev.sort((a, b) => b.t - a.t);
  return (
    <ul>
      {ev.map((e, i) => (
        <li key={i} className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5">
          <span className={`size-1.5 shrink-0 rounded-full ${e.ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
          <span className="min-w-0 flex-1 truncate text-ink-200">{e.text}</span>
          <span className="num text-[10.5px] text-ink-400">{new Date(e.t).toLocaleTimeString(locale(), { hour12: false })}</span>
        </li>
      ))}
    </ul>
  );
}
