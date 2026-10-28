import type { DataSource, Provenance } from '../../types/data';
import { t } from '../../i18n';

const META: Record<DataSource, { label: string; short: string; cls: string }> = {
  sensor: { label: 'Sensor measurement', short: 'SENSOR', cls: 'text-src-sensor border-src-sensor/40 bg-src-sensor/10' },
  'external-api': { label: 'External API', short: 'API', cls: 'text-src-api border-src-api/40 bg-src-api/10' },
  simulated: { label: 'Simulated / demo data', short: 'SIMULATED', cls: 'text-src-sim border-src-sim/40 bg-src-sim/10' },
  estimated: { label: 'Estimated / derived', short: 'ESTIMATE', cls: 'text-src-est border-src-est/40 bg-src-est/10' },
};

export function SourceBadge({ p, compact = false }: { p: Provenance; compact?: boolean }) {
  const m = META[p.source] ?? META.estimated; // provenance can arrive from the backend/AI at runtime
  const title = `${t(m.label)} — ${t(p.provider)}${p.note ? `\n${t(p.note)}` : ''}`;
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 cursor-help items-center gap-1 rounded border px-1.5 py-px text-[9.5px] font-semibold tracking-wider ${m.cls}`}
    >
      {t(m.short)}
      {!compact && <span className="font-normal tracking-normal opacity-80">· {t(p.provider)}</span>}
    </span>
  );
}

export function SourceLegend() {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.keys(META) as DataSource[]).map((k) => (
        <span key={k} className={`rounded border px-1.5 py-px text-[9.5px] font-semibold tracking-wider ${META[k].cls}`}>
          {t(META[k].short)}
          <span className="ml-1 font-normal tracking-normal opacity-80">{t(META[k].label)}</span>
        </span>
      ))}
    </div>
  );
}
