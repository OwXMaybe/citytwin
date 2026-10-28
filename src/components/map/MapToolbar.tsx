import { useState } from 'react';
import { Crosshair, Layers, Loader2 } from 'lucide-react';
import { useCity } from '../../hooks/CityDataContext';
import { useAppStore, type ColumnMetric, type LayerId } from '../../store/useAppStore';
import { useOsmStore } from '../../store/useOsmStore';
import { USE_CATEGORIES } from '../../services/osm/buildings';
import type { DataSource } from '../../types/data';
import { t } from '../../i18n';

const LAYER_META: { id: LayerId; label: string; source: DataSource; hint: string }[] = [
  { id: 'buildings', label: 'Buildings', source: 'external-api', hint: 'OpenStreetMap footprints & heights' },
  { id: 'green', label: 'Parks & green areas', source: 'external-api', hint: 'OpenStreetMap land cover' },
  { id: 'transit', label: 'Rail & transit lines', source: 'external-api', hint: 'OpenStreetMap rail/transit' },
  { id: 'traffic', label: 'Traffic congestion', source: 'simulated', hint: 'Live feed where available, otherwise synthetic on OSM roads' },
  { id: 'incidents', label: 'Closures & incidents', source: 'simulated', hint: 'Live disruptions where available, otherwise synthetic' },
  { id: 'stations', label: 'Ground air stations', source: 'sensor', hint: 'Measured PM at reference monitors (large) and low-cost sensors (small)' },
  { id: 'air', label: 'Air quality', source: 'external-api', hint: 'Open-Meteo CAMS model grid + IDW zones' },
  { id: 'energy', label: 'Energy by zone', source: 'simulated', hint: 'Consumption vs baseline' },
  { id: 'zones', label: 'District boundaries', source: 'external-api', hint: 'OSM administrative boundaries (hex grid if not imported)' },
  { id: 'vegetation', label: '3D trees (Three.js)', source: 'estimated', hint: 'OSM-mapped trees + illustrative park fill' },
  { id: 'columns', label: '3D district columns (Three.js)', source: 'estimated', hint: 'Extruded bars per district for a chosen metric' },
];

const SRC_DOT: Record<DataSource, string> = {
  sensor: 'bg-src-sensor',
  'external-api': 'bg-src-api',
  simulated: 'bg-src-sim',
  estimated: 'bg-src-est',
};

export function MapToolbar({ trafficBusy }: { trafficBusy: boolean }) {
  const mapMode = useAppStore((s) => s.mapMode);
  const setMapMode = useAppStore((s) => s.setMapMode);
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const columnMetric = useAppStore((s) => s.columnMetric);
  const setColumnMetric = useAppStore((s) => s.setColumnMetric);
  const flyTo = useAppStore((s) => s.flyTo);
  const showSim = useAppStore((s) => s.settings.showSimulated);
  const { city, liveTraffic } = useCity();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="absolute top-3 left-3 z-10 flex items-start gap-2">
        <div className="flex overflow-hidden rounded border border-ink-600 bg-ink-900/95 shadow-lg" role="group" aria-label={t('Map mode')}>
          {(['2d', '3d'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMapMode(m)}
              aria-pressed={mapMode === m}
              className={`h-8 px-3 text-xs font-semibold tracking-wider uppercase ${mapMode === m ? 'bg-accent/15 text-accent' : 'text-ink-300 hover:text-ink-100'}`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="relative">
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={`flex h-8 items-center gap-1.5 rounded border bg-ink-900/95 px-2.5 text-xs shadow-lg ${open ? 'border-accent text-accent' : 'border-ink-600 text-ink-200 hover:border-ink-500'}`}
          >
            <Layers className="size-3.5" /> {t('Layers')}
            <span className="num rounded bg-ink-700 px-1 text-[10px] text-ink-200">{Object.values(layers).filter(Boolean).length}</span>
          </button>
          {open && (
            <div className="fade-in absolute top-9 left-0 w-64 rounded border border-ink-600 bg-ink-900/97 p-1.5 shadow-xl">
              {LAYER_META.map((l) => {
                const live = (l.id === 'traffic' || l.id === 'incidents') && !!liveTraffic.data;
                const source = live ? (liveTraffic.data!.provenance.source) : l.source;
                const disabled = source === 'simulated' && !showSim;
                return (
                  <label key={l.id} className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-ink-800 ${disabled ? 'opacity-40' : ''}`} title={t(disabled ? 'Simulated data is hidden in Settings' : l.hint)}>
                    <input type="checkbox" checked={layers[l.id]} disabled={disabled} onChange={() => toggleLayer(l.id)} className="mt-0.5 accent-cyan-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-ink-100">
                        {t(l.label)}
                        <span className={`size-1.5 rounded-full ${SRC_DOT[source]}`} />
                      </div>
                      <div className="text-[10.5px] text-ink-400">{t(l.hint)}</div>
                    </div>
                  </label>
                );
              })}
              {layers.columns && (
                <div className="mx-2 mt-1 mb-1 flex items-center gap-2 border-t border-ink-700 pt-2">
                  <span className="text-[11px] text-ink-400">{t('Column metric')}</span>
                  <select
                    value={columnMetric}
                    onChange={(e) => setColumnMetric(e.target.value as ColumnMetric)}
                    className="ml-auto h-7 rounded border border-ink-600 bg-ink-800 px-1 text-xs text-ink-100"
                  >
                    <option value="population">{t('Population')}</option>
                    <option value="pm25">{t('PM2.5 (interpolated)')}</option>
                    <option value="energy" disabled={!showSim}>{t('Energy (simulated)')}</option>
                    <option value="traffic" disabled={!showSim}>{t('Traffic (simulated)')}</option>
                  </select>
                </div>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => flyTo({ lon: city.lon, lat: city.lat, zoom: city.zoom })}
          title={t('Recenter on city')}
          className="flex size-8 items-center justify-center rounded border border-ink-600 bg-ink-900/95 text-ink-200 shadow-lg hover:border-accent hover:text-accent"
        >
          <Crosshair className="size-3.5" />
        </button>
        {trafficBusy && <Loader2 className="mt-2 size-4 animate-spin text-accent" />}
      </div>
      <Legend />
    </>
  );
}

function Legend() {
  const layers = useAppStore((s) => s.layers);
  const showSim = useAppStore((s) => s.settings.showSimulated);
  const colorMode = useOsmStore((s) => s.colorMode);
  const items: { title: string; tag: string; stops: [string, string][] }[] = [];
  if (layers.buildings && colorMode === 'use')
    items.push({ title: 'Building use', tag: 'OSM TAGS', stops: [...USE_CATEGORIES.map((c) => [c.color, c.label.split(' /')[0]] as [string, string]), ['#2b3a55', 'Not imported']] });
  const live = useCity().liveTraffic.data;
  if (layers.stations)
    items.push({ title: 'Ground PM2.5 (µg/m³)', tag: 'MEASURED', stops: [['#22c55e', '<10'], ['#84cc16', '<20'], ['#eab308', '<25'], ['#f97316', '<50'], ['#ef4444', '<75'], ['#a855f7', '75+']] });
  if (layers.traffic && (showSim || live?.segments))
    items.push({ title: live?.segments ? live.indexLabel === 'Corridor delay index' ? 'Disrupted streets (TfL)' : 'Measured congestion' : 'Traffic congestion', tag: live?.segments ? 'LIVE' : live ? 'SIM · SCALED TO LIVE INDEX' : 'SIMULATED', stops: [['#22c55e', 'Free'], ['#eab308', 'Moderate'], ['#f97316', 'Heavy'], ['#ef4444', 'Severe']] });
  if (layers.air)
    items.push({ title: 'European AQI', tag: 'API · MODEL', stops: [['#22c55e', '≤20'], ['#84cc16', '≤40'], ['#eab308', '≤60'], ['#f97316', '≤80'], ['#ef4444', '≤100'], ['#a855f7', '>100']] });
  if (layers.energy && showSim)
    items.push({ title: 'Energy vs baseline', tag: 'SIMULATED', stops: [['#1e40af', '−15%'], ['#0e7490', '0%'], ['#ca8a04', '+15%'], ['#dc2626', '+35%']] });
  if (!items.length) return null;
  return (
    <div className="absolute bottom-9 left-3 z-10 flex flex-col gap-1.5">
      {items.map((it) => (
        <div key={it.title} className="rounded border border-ink-600 bg-ink-900/95 px-2.5 py-1.5 shadow-lg">
          <div className="mb-1 flex items-center gap-2 text-[10.5px] font-semibold tracking-wider text-ink-200 uppercase">
            {t(it.title)}
            <span className="font-normal text-ink-400">{t(it.tag)}</span>
          </div>
          <div className="flex gap-2">
            {it.stops.map(([c, l]) => (
              <span key={l} className="flex items-center gap-1 text-[10.5px] text-ink-300">
                <span className="h-2 w-3 rounded-sm" style={{ background: c }} />
                {t(l)}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
