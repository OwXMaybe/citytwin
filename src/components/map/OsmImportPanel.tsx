import { useRef } from 'react';
import { CheckCircle2, CloudDownload, FileUp, Loader2, Trash2, TriangleAlert } from 'lucide-react';
import { useCity } from '../../hooks/CityDataContext';
import { fmt, fmtInt } from '../../lib/format';
import { USE_CATEGORIES } from '../../services/osm/buildings';
import { importOsmFile } from '../../services/osm/fileImport';
import { bboxAreaKm2, importView, MAX_IMPORT_KM2, type BBox } from '../../services/osm/viewImport';
import { useOsmStore } from '../../store/useOsmStore';
import { t, locale } from '../../i18n';

/** Reads the live map viewport (the 3D City page owns the map instance). */
export type ViewportGetter = () => { bbox: BBox; zoom: number } | null;

export function OsmImportPanel({ getViewport }: { getViewport: ViewportGetter }) {
  const { city } = useCity();
  const { status, setStatus, addImport, clear, log, buildings, trees, colorMode, setColorMode } = useOsmStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = status.state === 'loading';

  const runViewImport = async (force = false) => {
    const vp = getViewport();
    if (!vp) return;
    if (bboxAreaKm2(vp.bbox) > MAX_IMPORT_KM2) {
      setStatus({ state: 'error', message: t('The view covers {area} km². Zoom in to under {max} km² (about zoom 15) to import.', { area: fmt(bboxAreaKm2(vp.bbox)), max: MAX_IMPORT_KM2 }) });
      return;
    }
    setStatus({ state: 'loading', message: t('Checking cache…') });
    try {
      const res = await importView(vp.bbox, { force, onStatus: (m) => setStatus({ state: 'loading', message: t(m) }) });
      addImport(city.id, res, res.fromCache);
      setStatus({ state: 'done', message: t('{b} buildings, {tr} trees from {src}.', { b: fmtInt(res.buildings.length), tr: fmtInt(res.trees.length), src: res.fromCache ? t('local cache') : res.source }) });
    } catch (e) {
      setStatus({ state: 'error', message: t((e as Error).message) });
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setStatus({ state: 'loading', message: t('Parsing {name}…', { name: file.name }) });
    try {
      const res = await importOsmFile(file);
      addImport(city.id, res, false);
      setStatus({ state: 'done', message: t('{b} buildings, {tr} trees from {src}.', { b: fmtInt(res.buildings.length), tr: fmtInt(res.trees.length), src: file.name }) });
    } catch (e) {
      setStatus({ state: 'error', message: t((e as Error).message) });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div>
      <div className="flex gap-1.5">
        <button
          onClick={() => runViewImport()}
          disabled={busy}
          className="flex flex-1 items-center justify-center gap-1.5 rounded border border-accent/50 bg-accent/10 py-1.5 text-xs text-accent hover:bg-accent/20 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CloudDownload className="size-3.5" />} {t('Import OSM data for view')}
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title={t('Load an OSM XML (.osm) or overpass-turbo GeoJSON export')}
          className="flex items-center gap-1 rounded border border-ink-600 px-2 text-xs text-ink-200 hover:border-ink-500 disabled:opacity-50"
        >
          <FileUp className="size-3.5" /> {t('File')}
        </button>
        <input ref={fileRef} type="file" accept=".osm,.xml,.geojson,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      </div>

      {status.state !== 'idle' && (
        <div
          className={`mt-2 flex items-start gap-1.5 rounded px-2 py-1.5 text-[11.5px] ${
            status.state === 'error' ? 'bg-red-500/10 text-red-300' : status.state === 'done' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-ink-800 text-ink-200'
          }`}
        >
          {status.state === 'error' ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> : status.state === 'done' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />}
          <span>{status.message}</span>
          {status.state === 'error' && (
            <button onClick={() => runViewImport(true)} className="ml-auto shrink-0 underline">{t('Retry')}</button>
          )}
        </div>
      )}

      {buildings.size > 0 && (
        <>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-ink-400">{t('Colour buildings by')}</span>
            <div className="ml-auto flex overflow-hidden rounded border border-ink-600">
              {(['height', 'use'] as const).map((m) => (
                <button key={m} onClick={() => setColorMode(m)} className={`px-2 py-0.5 text-[11px] capitalize ${colorMode === m ? 'bg-accent/15 text-accent' : 'text-ink-300'}`}>
                  {t(m)}
                </button>
              ))}
            </div>
          </div>
          <BuildingStats />
          <div className="mt-2 flex items-center gap-2 text-[10.5px] text-ink-400">
            <span>{t('{b} buildings · {tr} trees in session', { b: fmtInt(buildings.size), tr: fmtInt(trees.length) })}</span>
            <button onClick={clear} className="ml-auto flex items-center gap-1 hover:text-ink-100"><Trash2 className="size-3" /> {t('Clear')}</button>
          </div>
          <ul className="mt-1 space-y-0.5 text-[10.5px] text-ink-400">
            {log.slice(0, 3).map((l, i) => (
              <li key={i} className="truncate" title={l.osmTimestamp ? t('OSM data as of {ts}', { ts: l.osmTimestamp }) : undefined}>
                {new Date(l.importedAt).toLocaleTimeString(locale())} · {l.source}{l.fromCache ? ` (${t('cached')})` : ''} · {l.buildings} {t('bldg')}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-[10.5px] text-ink-400">
        {t('Live imports query the public Overpass API (fair use, up to {max} km²) and are cached locally for 7 days. © OpenStreetMap contributors, ODbL.', { max: MAX_IMPORT_KM2 })}
      </p>
    </div>
  );
}

function BuildingStats() {
  const buildings = useOsmStore((s) => s.buildings);
  const list = [...buildings.values()];
  const byCat = USE_CATEGORIES.map((c) => ({ ...c, n: list.filter((b) => b.category === c.id).length })).filter((c) => c.n > 0);
  const withLevels = list.filter((b) => b.levels != null);
  const levels = withLevels.map((b) => b.levels!).sort((a, b) => a - b);
  const median = levels.length ? levels[Math.floor(levels.length / 2)] : null;
  const years = list.map((b) => parseInt(b.startDate ?? '', 10)).filter((y) => y > 1000 && y < 2100);
  const footprint = list.reduce((s, b) => s + b.footprintM2, 0);
  return (
    <div className="mt-2">
      <div className="flex h-2.5 overflow-hidden rounded">
        {byCat.map((c) => <span key={c.id} title={`${t(c.label)}: ${c.n}`} style={{ width: `${(c.n / list.length) * 100}%`, background: c.color }} />)}
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
        {byCat.map((c) => (
          <div key={c.id} className="flex items-center gap-1.5 text-[11px]">
            <span className="size-2 rounded-sm" style={{ background: c.color }} />
            <span className="truncate text-ink-300">{t(c.label)}</span>
            <span className="num ml-auto text-ink-100">{c.n}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
        <Mini label="Levels tagged" value={`${fmtInt((withLevels.length / list.length) * 100)}%`} />
        <Mini label="Median levels" value={median ?? '—'} />
        <Mini label="Footprint" value={`${fmt(footprint / 1e4)} ha`} />
      </div>
      {years.length > 0 && <p className="mt-1 text-[10.5px] text-ink-400">{t('Construction year tagged on {n} buildings (oldest {y}).', { n: years.length, y: Math.min(...years) })}</p>}
    </div>
  );
}

const Mini = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded bg-ink-800 px-1 py-1">
    <div className="num text-sm text-ink-100">{value}</div>
    <div className="text-[9.5px] tracking-wide text-ink-400 uppercase">{t(label)}</div>
  </div>
);
