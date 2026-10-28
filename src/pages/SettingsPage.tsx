import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Panel } from '../components/ui/Panel';
import { SourceLegend } from '../components/ui/SourceBadge';
import { useCity } from '../hooks/CityDataContext';
import { DEFAULT_SETTINGS, useAppStore } from '../store/useAppStore';
import { t, LANGUAGES } from '../i18n';

export function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.updateSettings);
  const setMapMode = useAppStore((s) => s.setMapMode);
  const qc = useQueryClient();
  const { feeds } = useCity();

  return (
    <div className="h-full overflow-y-auto p-3">
      <h1 className="mb-3 text-lg font-semibold">{t('Settings')}</h1>
      <div className="grid max-w-5xl grid-cols-1 gap-2 lg:grid-cols-2">
        <Panel title="Data">
          <Row label="Refresh interval" hint="How often external APIs are polled. Open-Meteo updates hourly.">
            <select value={settings.refreshMinutes} onChange={(e) => update({ refreshMinutes: Number(e.target.value) })} className="h-8 rounded border border-ink-600 bg-ink-800 px-2 text-ink-100">
              {[0, 5, 10, 30, 60].map((m) => <option key={m} value={m}>{m === 0 ? t('Manual only') : t('{m} min', { m })}</option>)}
            </select>
          </Row>
          <Row label="Show simulated data" hint="Hide all synthetic traffic, energy and zone values to see only real/external data.">
            <Toggle on={settings.showSimulated} onChange={(v) => update({ showSimulated: v })} />
          </Row>
          <Row label="Refresh now" hint="Re-fetch all external feeds.">
            <button onClick={() => qc.invalidateQueries()} className="flex h-8 items-center gap-1.5 rounded border border-ink-600 px-3 text-ink-200 hover:border-accent hover:text-accent">
              <RefreshCw className="size-3.5" /> {t('Refresh')}
            </button>
          </Row>
        </Panel>
        <Panel title="Display">
          <Row label="Language" hint="Interface language. Claude answers in the language you write in.">
            <div className="flex overflow-hidden rounded border border-ink-600">
              {LANGUAGES.map((l) => (
                <button key={l.id} onClick={() => update({ language: l.id })} className={`h-8 px-3 ${settings.language === l.id ? 'bg-accent/15 text-accent' : 'text-ink-300'}`}>{l.label}</button>
              ))}
            </div>
          </Row>
          <Row label="Temperature unit">
            <div className="flex overflow-hidden rounded border border-ink-600">
              {(['C', 'F'] as const).map((u) => (
                <button key={u} onClick={() => update({ temperatureUnit: u })} className={`h-8 px-3 ${settings.temperatureUnit === u ? 'bg-accent/15 text-accent' : 'text-ink-300'}`}>°{u}</button>
              ))}
            </div>
          </Row>
          <Row label="Default map mode">
            <div className="flex overflow-hidden rounded border border-ink-600">
              {(['2d', '3d'] as const).map((m) => (
                <button key={m} onClick={() => { update({ defaultMapMode: m }); setMapMode(m); }} className={`h-8 px-3 uppercase ${settings.defaultMapMode === m ? 'bg-accent/15 text-accent' : 'text-ink-300'}`}>{m}</button>
              ))}
            </div>
          </Row>
          <Row label="Reset preferences">
            <button onClick={() => update(DEFAULT_SETTINGS)} className="h-8 rounded border border-ink-600 px-3 text-ink-200 hover:border-ink-500">{t('Reset')}</button>
          </Row>
        </Panel>
        <Panel title="Live data sources" className="lg:col-span-2">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[10.5px] tracking-wider text-ink-400 uppercase">
              <tr className="border-b border-ink-700"><th className="py-1.5">{t('City')}</th><th>{t('Traffic')}</th><th>{t('Ground air stations')}</th></tr>
            </thead>
            <tbody className="text-ink-200">
              <tr className="border-b border-ink-800"><td className="py-1.5">Istanbul</td><td>{t('İBB traffic index (live + 8-day history)')}</td><td>{t('İBB municipal reference stations')}</td></tr>
              <tr className="border-b border-ink-800"><td className="py-1.5">{t('London')}</td><td>{t('TfL corridors + live disruptions')}</td><td>{t('Sensor.Community (low-cost)')}</td></tr>
              <tr className="border-b border-ink-800"><td className="py-1.5">New York</td><td>{t('NYC DOT measured link speeds')}</td><td>{t('OpenAQ only (key needed)')}</td></tr>
              <tr className="border-b border-ink-800"><td className="py-1.5">Berlin</td><td className="text-ink-400">{t('simulated (VIZ feed stale since 2025)')}</td><td>{t('Sensor.Community (low-cost)')}</td></tr>
              <tr><td className="py-1.5">Ankara, İzmir, Tekirdağ, Edirne, Bursa, Kocaeli, Antalya</td><td className="text-ink-400">{t('simulated (no public feed)')}</td><td>{t('Sensor.Community where sensors exist, OpenAQ (key)')}</td></tr>
            </tbody>
          </table>
          <p className="mt-2 text-[11.5px] text-ink-400">
            {t('OpenAQ adds government monitors for every city. Create a free key at explore.openaq.org, put OPENAQ_API_KEY=… in .env.local and restart the CityTwin backend (or npm run dev in direct mode).')}{' '}
            {t('The key is added server-side and never sent to the browser. The same file takes ANTHROPIC_API_KEY, which enables Claude in the AI Assistant.')}
          </p>
        </Panel>
        <Panel title="Data sources & provenance" className="lg:col-span-2">
          <SourceLegend />
          <table className="mt-3 w-full text-left">
            <thead className="text-[10.5px] tracking-wider text-ink-400 uppercase">
              <tr className="border-b border-ink-700"><th className="py-1.5">{t('Feed')}</th><th>{t('Status')}</th><th>{t('Detail')}</th></tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.id} className="border-b border-ink-800">
                  <td className="py-1.5 text-ink-100">{t(f.label)}</td>
                  <td className="text-[11px] tracking-wider text-ink-300 uppercase">{t(f.state)}</td>
                  <td className="text-ink-400">{t(f.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-ink-800 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-ink-100">{t(label)}</div>
        {hint && <div className="text-[11px] text-ink-400">{t(hint)}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-ink-600'}`}>
      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${on ? 'left-4.5' : 'left-0.5'}`} />
    </button>
  );
}
