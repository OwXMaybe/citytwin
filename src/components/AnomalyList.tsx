import { AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import { useCity } from '../hooks/CityDataContext';
import { fmt } from '../lib/format';
import { KIND_LABEL, POLLUTANT_LABEL, type AnomalySeverity } from '../services/anomalies';
import { useAppStore } from '../store/useAppStore';
import { ErrorState, Loading } from './ui/Panel';
import { t, locale } from '../i18n';

const SEV: Record<AnomalySeverity, { icon: typeof Info; cls: string }> = {
  critical: { icon: AlertOctagon, cls: 'text-red-400' },
  warning: { icon: AlertTriangle, cls: 'text-orange-400' },
  info: { icon: Info, cls: 'text-sky-400' },
};

/** Anomalies the backend's detector found in measured station readings. */
export function AnomalyList({ limit = 12, dense = false }: { limit?: number; dense?: boolean }) {
  const { anomalies, backend } = useCity();
  const select = useAppStore((s) => s.select);
  const flyTo = useAppStore((s) => s.flyTo);
  const setPage = useAppStore((s) => s.setPage);

  if (!backend.data) return <p className={`text-ink-400 ${dense ? 'text-[11px]' : 'p-3'}`}>{t('Anomaly detection runs on the CityTwin backend, which isn’t reachable (direct mode).')}</p>;
  if (anomalies.isLoading) return <Loading label="Scanning readings…" />;
  if (anomalies.isError) return <ErrorState error={anomalies.error} onRetry={() => anomalies.refetch()} />;
  const r = anomalies.data;
  if (!r) return null;

  const covered = Object.entries(r.coverage).filter(([, c]) => c.stations > 0);
  const coverage = covered.length
    ? covered.map(([p, c]) => `${POLLUTANT_LABEL[p]} ${t('{n} st ({h} w/ history', { n: c.stations, h: c.withHistory })}${c.isolationForest ? ', IF' : ''})`).join(' · ')
    : t('No stations reporting recently');

  return (
    <div>
      <p className={`text-[10.5px] text-ink-400 ${dense ? 'mb-1' : 'border-b border-ink-800 px-3 py-1.5'}`} title={`${r.method.model}\n${t('Features')}: ${r.method.features.join('; ')}\n${r.method.limitations}`}>
        {t('Scanned')} {new Date(r.generatedAt).toLocaleTimeString(locale())} · {coverage}
      </p>
      {r.episodes.map((e) => {
        const S = SEV[e.severity];
        return (
          <div key={e.pollutant} className={`flex gap-2 ${dense ? 'py-1' : 'border-b border-ink-800 px-3 py-2'}`}>
            <S.icon className={`mt-0.5 size-4 shrink-0 ${S.cls}`} />
            <p className="text-ink-200">{t(e.explanation)}</p>
          </div>
        );
      })}
      {r.anomalies.length === 0 && r.episodes.length === 0 && <p className={`text-ink-400 ${dense ? 'text-[11px]' : 'px-3 py-2'}`}>{t('Nothing unusual in the latest readings.')}</p>}
      <ul>
        {r.anomalies.slice(0, limit).map((a) => {
          const S = SEV[a.severity];
          return (
            <li key={`${a.sensorId}-${a.pollutant}-${a.kind}`}>
              <button
                onClick={() => { select({ kind: 'station', stationId: a.sensorId }); flyTo({ lon: a.lon, lat: a.lat, zoom: 14 }); setPage('environment'); }}
                title={t(a.explanation)}
                className={`flex w-full gap-2 text-left hover:bg-ink-800 ${dense ? 'rounded px-1 py-0.5' : 'border-b border-ink-800 px-3 py-1.5'}`}
              >
                <S.icon className={`mt-0.5 size-3.5 shrink-0 ${S.cls}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-ink-100">{a.sensorName}</span>
                    {a.grade === 'low-cost' && <span className="shrink-0 text-[9.5px] text-ink-400 uppercase">{t('low-cost')}</span>}
                    <span className="num ml-auto shrink-0 text-ink-100">{POLLUTANT_LABEL[a.pollutant]} {fmt(a.value)}</span>
                  </span>
                  <span className="flex gap-1.5 text-[10.5px] text-ink-400">
                    <span>{t(KIND_LABEL[a.kind])}</span>
                    {a.district && <span className="truncate">· {a.district}</span>}
                    {a.expected != null && <span className="num ml-auto shrink-0">{t('exp.')} {fmt(a.expected)} · z {fmt(Math.max(a.zTemporal ?? 0, a.zSpatial ?? 0))}</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {r.anomalies.length > limit && <p className={`text-[10.5px] text-ink-400 ${dense ? '' : 'px-3 py-1.5'}`}>{t('+{n} more', { n: r.anomalies.length - limit })}</p>}
    </div>
  );
}
