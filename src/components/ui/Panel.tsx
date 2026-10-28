import type { ReactNode } from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import type { Provenance } from '../../types/data';
import { SourceBadge } from './SourceBadge';
import { useAppStore } from '../../store/useAppStore';
import { t, tx } from '../../i18n';

export function Panel({
  title,
  source,
  actions,
  children,
  className = '',
  bodyClassName = 'p-3',
}: {
  title?: ReactNode;
  source?: Provenance;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col rounded-md border border-ink-700 bg-ink-850 ${className}`}>
      {(title || source || actions) && (
        <header className="flex min-h-9 items-center gap-2 border-b border-ink-700 px-3 py-1.5">
          {title && <h3 className="truncate text-[11px] font-semibold tracking-wider text-ink-200 uppercase">{tx(title)}</h3>}
          <div className="ml-auto flex items-center gap-2">
            {actions}
            {source && <SourceBadge p={source} compact />}
          </div>
        </header>
      )}
      {/* grow (basis auto), not flex-1, so an explicit body height like h-72 is respected */}
      <div className={`min-h-0 grow ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Loading({ label = 'Loading…', className = '' }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-2 py-6 text-ink-300 ${className}`}>
      <Loader2 className="size-4 animate-spin text-accent" />
      <span>{t(label)}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, className = '' }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className={`flex flex-col items-center justify-center gap-2 py-5 text-center ${className}`}>
      <AlertTriangle className="size-5 text-amber-400" />
      <p className="max-w-xs text-ink-300">{t(msg)}</p>
      {onRetry && (
        <button onClick={onRetry} className="inline-flex items-center gap-1 rounded border border-ink-600 px-2 py-1 text-xs text-ink-200 hover:border-accent hover:text-accent">
          <RotateCw className="size-3" /> {t('Retry')}
        </button>
      )}
    </div>
  );
}

/**
 * Renders children only when simulated data is enabled in Settings.
 * `force` bypasses the gate when the content is backed by a live feed.
 */
export function SimGate({ children, compact = false, force = false }: { children: ReactNode; compact?: boolean; force?: boolean }) {
  const show = useAppStore((s) => s.settings.showSimulated);
  if (show || force) return <>{children}</>;
  return (
    <div className={`flex items-center justify-center text-center text-ink-400 ${compact ? 'py-1 text-xs' : 'py-6'}`}>
      {t('Simulated data hidden (Settings → Data)')}
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  source,
  accent,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  source?: Provenance;
  accent?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="truncate text-[10.5px] font-medium tracking-wider text-ink-300 uppercase">{t(label)}</span>
        {source && <span className="ml-auto"><SourceBadge p={source} compact /></span>}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="num text-xl font-semibold" style={accent ? { color: accent } : undefined}>{value}</span>
        {unit && <span className="text-ink-300">{t(unit)}</span>}
      </div>
      {sub && <div className="truncate text-[11px] text-ink-400">{tx(sub)}</div>}
    </div>
  );
}

export function KV({ k, v, source }: { k: ReactNode; v: ReactNode; source?: Provenance }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-ink-300">{tx(k)}</span>
      <span className="num ml-auto text-right text-ink-100">{tx(v)}</span>
      {source && <SourceBadge p={source} compact />}
    </div>
  );
}
