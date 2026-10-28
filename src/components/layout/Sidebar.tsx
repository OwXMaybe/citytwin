import {
  Activity,
  Bot,
  Building2,
  Car,
  FileText,
  FlaskConical,
  Gauge,
  Leaf,
  Settings as SettingsIcon,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useAppStore, type PageId } from '../../store/useAppStore';
import { t } from '../../i18n';

export const NAV: { id: PageId; label: string; icon: LucideIcon; group: 'monitor' | 'analyze' | 'system' }[] = [
  { id: 'overview', label: 'Overview', icon: Gauge, group: 'monitor' },
  { id: 'city3d', label: '3D City', icon: Building2, group: 'monitor' },
  { id: 'traffic', label: 'Traffic Intelligence', icon: Car, group: 'monitor' },
  { id: 'environment', label: 'Environment', icon: Leaf, group: 'monitor' },
  { id: 'energy', label: 'Energy', icon: Zap, group: 'monitor' },
  { id: 'simulation', label: 'Urban Simulation', icon: FlaskConical, group: 'analyze' },
  { id: 'assistant', label: 'AI Assistant', icon: Bot, group: 'analyze' },
  { id: 'reports', label: 'Reports', icon: FileText, group: 'analyze' },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, group: 'system' },
];

const GROUPS = { monitor: 'Monitor', analyze: 'Analyze', system: 'System' } as const;

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  return (
    <nav className="no-print flex w-14 shrink-0 flex-col border-r border-ink-700 bg-ink-900 lg:w-52">
      <div className="flex h-12 items-center gap-2 border-b border-ink-700 px-3.5">
        <Activity className="size-5 shrink-0 text-accent" />
        <div className="hidden leading-tight lg:block">
          <div className="text-sm font-semibold tracking-wide">CityTwin</div>
          <div className="text-[10px] text-ink-400">{t('Urban Intelligence')}</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {(Object.keys(GROUPS) as (keyof typeof GROUPS)[]).map((g) => (
          <div key={g} className="mb-2">
            <div className="hidden px-4 pt-2 pb-1 text-[10px] font-semibold tracking-widest text-ink-400 uppercase lg:block">{t(GROUPS[g])}</div>
            {NAV.filter((n) => n.group === g).map((n) => {
              const active = page === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setPage(n.id)}
                  title={t(n.label)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors ${
                    active ? 'bg-ink-800 text-accent' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
                  }`}
                >
                  {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-accent" />}
                  <n.icon className="size-4 shrink-0" />
                  <span className="hidden truncate lg:inline">{t(n.label)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="hidden border-t border-ink-700 px-4 py-2 text-[10px] text-ink-400 lg:block">
        {t('Phase 5 · v0.5.0')}
      </div>
    </nav>
  );
}
