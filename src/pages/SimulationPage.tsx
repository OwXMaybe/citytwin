import { useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { RotateCcw, Save, Trash2 } from 'lucide-react';
import { CHART } from '../components/charts/Charts';
import { Panel, SimGate } from '../components/ui/Panel';
import { SourceBadge } from '../components/ui/SourceBadge';
import { useCity } from '../hooks/CityDataContext';
import { fmt } from '../lib/format';
import { ASSUMPTIONS, DEFAULT_SCENARIO, runScenario, SCENARIO_PROVENANCE, type ScenarioInput, type ScenarioResult } from '../services/simulationEngine';
import { t } from '../i18n';

interface Saved {
  name: string;
  input: ScenarioInput;
  result: ScenarioResult;
}

export function SimulationPage() {
  const { zones, city } = useCity();
  const [input, setInput] = useState<ScenarioInput>(DEFAULT_SCENARIO);
  const [saved, setSaved] = useState<Saved[]>([]);
  const result = useMemo(() => runScenario(zones, input), [zones, input]);
  const patch = (p: Partial<ScenarioInput>) => setInput((s) => ({ ...s, ...p }));
  const changed = result.zones.filter((z) => z.trafficAfter !== z.trafficBefore);

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold">{t('Urban Simulation')} · {city.name}</h1>
          <p className="text-ink-400">{t('Explore what-if scenarios against the current baseline. All outputs are heuristic estimates.')}</p>
        </div>
        <div className="ml-auto"><SourceBadge p={SCENARIO_PROVENANCE} /></div>
      </div>

      <SimGate>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-[340px_1fr]">
          <div className="flex flex-col gap-2">
            <Panel title="Road closure">
              <ZoneSelect value={input.closureZoneId} onChange={(v) => patch({ closureZoneId: v })} zones={zones} />
              <Slider label="Capacity removed" value={input.closureSeverity * 100} min={0} max={100} unit="%" onChange={(v) => patch({ closureSeverity: v / 100 })} disabled={!input.closureZoneId} />
            </Panel>
            <Panel title="New road / alternative route">
              <ZoneSelect value={input.newRouteZoneId} onChange={(v) => patch({ newRouteZoneId: v })} zones={zones} />
              <Slider label="Capacity added" value={input.newRouteCapacity * 100} min={0} max={50} unit="%" onChange={(v) => patch({ newRouteCapacity: v / 100 })} disabled={!input.newRouteZoneId} />
            </Panel>
            <Panel title="Green space">
              <Slider label="Additional green cover" value={input.greenIncreasePp} min={0} max={20} unit="pp" onChange={(v) => patch({ greenIncreasePp: v })} />
            </Panel>
            <Panel title="Energy">
              <Slider label="Efficiency improvement" value={input.efficiencyPct} min={0} max={40} unit="%" onChange={(v) => patch({ efficiencyPct: v })} />
              <Slider label="Rooftop solar adoption" value={input.solarAdoptionPct} min={0} max={60} unit="%" onChange={(v) => patch({ solarAdoptionPct: v })} />
            </Panel>
            <div className="flex gap-2">
              <button
                onClick={() => setSaved((s) => [...s.slice(-2), { name: `${t('Scenario')} ${String.fromCharCode(65 + (s.length % 26))}`, input, result }])}
                className="flex flex-1 items-center justify-center gap-1.5 rounded border border-accent/50 bg-accent/10 py-2 text-accent hover:bg-accent/20"
              >
                <Save className="size-3.5" /> {t('Save for comparison')}
              </button>
              <button onClick={() => setInput(DEFAULT_SCENARIO)} className="flex items-center gap-1.5 rounded border border-ink-600 px-3 text-ink-300 hover:text-ink-100">
                <RotateCcw className="size-3.5" /> {t('Reset')}
              </button>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Delta label="Zone-avg congestion" before={result.cityTrafficBefore} after={result.cityTrafficAfter} unit="/100" lowerIsBetter />
              <Delta label="Energy demand" before={result.energyBefore} after={result.energyAfter} unit="MWh/d" lowerIsBetter digits={0} />
              <Delta label="CO₂ from electricity" before={result.co2Before} after={result.co2After} unit="t/d" lowerIsBetter digits={0} />
              <Delta label="Green cover" before={result.greenBefore} after={result.greenAfter} unit="%" />
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-2">
              <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
                <div className="text-[10.5px] tracking-wider text-ink-300 uppercase">{t('Est. local cooling from greening')}</div>
                <div className="num text-xl font-semibold text-emerald-400">−{fmt(result.coolingC)} °C</div>
              </div>
              <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
                <div className="text-[10.5px] tracking-wider text-ink-300 uppercase">{t('Est. rooftop solar generation')}</div>
                <div className="num text-xl font-semibold text-amber-400">{fmt(result.solarMWhDay)} MWh/d</div>
              </div>
            </div>
            <Panel title="Before / after by zone · traffic index" source={SCENARIO_PROVENANCE}>
              {changed.length === 0 ? (
                <p className="py-10 text-center text-ink-400">{t('Choose a zone for a road closure or new route to see traffic effects.')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={changed} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="name" stroke={CHART.axis} tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} />
                    <YAxis domain={[0, 100]} width={32} stroke={CHART.axis} tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} />
                    <Tooltip contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, fontSize: 12 }} cursor={{ fill: '#18253f' }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="trafficBefore" name={t('Before')} fill="#5c7096" isAnimationActive={false} />
                    <Bar dataKey="trafficAfter" name={t('After (estimate)')} fill="#22d3ee" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Panel>
            {saved.length > 0 && (
              <Panel title="Scenario comparison" actions={<button onClick={() => setSaved([])} className="text-ink-400 hover:text-ink-100" aria-label={t('Clear saved scenarios')}><Trash2 className="size-3.5" /></button>} bodyClassName="overflow-x-auto p-0">
                <table className="num w-full text-left">
                  <thead className="text-[10.5px] tracking-wider text-ink-400 uppercase">
                    <tr className="border-b border-ink-700">
                      <th className="px-3 py-1.5 font-sans font-medium">{t('Metric')}</th>
                      <th className="px-3 py-1.5 text-right font-sans font-medium">{t('Baseline')}</th>
                      {saved.map((s) => <th key={s.name} className="px-3 py-1.5 text-right font-sans font-medium">{s.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <Row label="City congestion" base={result.cityTrafficBefore} vals={saved.map((s) => s.result.cityTrafficAfter)} />
                    <Row label="Energy MWh/d" base={result.energyBefore} vals={saved.map((s) => s.result.energyAfter)} d={0} />
                    <Row label="CO₂ t/d" base={result.co2Before} vals={saved.map((s) => s.result.co2After)} d={0} />
                    <Row label="Green cover %" base={result.greenBefore} vals={saved.map((s) => s.result.greenAfter)} />
                    <Row label="Cooling °C" base={0} vals={saved.map((s) => -s.result.coolingC)} />
                  </tbody>
                </table>
              </Panel>
            )}
            <Panel title="Model assumptions">
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 md:grid-cols-2">
                {ASSUMPTIONS.map((a) => (
                  <div key={a.k}>
                    <dt className="text-[11px] font-semibold text-ink-200">{t(a.k)}</dt>
                    <dd className="text-[11.5px] text-ink-400">{t(a.v)}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </div>
        </div>
      </SimGate>
    </div>
  );
}

function Row({ label, base, vals, d = 1 }: { label: string; base: number; vals: number[]; d?: number }) {
  return (
    <tr className="border-b border-ink-800">
      <td className="px-3 py-1.5 font-sans text-ink-200">{t(label)}</td>
      <td className="px-3 py-1.5 text-right text-ink-300">{fmt(base, d)}</td>
      {vals.map((v, i) => <td key={i} className="px-3 py-1.5 text-right text-ink-100">{fmt(v, d)}</td>)}
    </tr>
  );
}

function ZoneSelect({ value, onChange, zones }: { value: string | null; onChange: (v: string | null) => void; zones: { id: string; name: string }[] }) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="mb-2 h-8 w-full rounded border border-ink-600 bg-ink-800 px-2 text-ink-100 outline-none focus:border-accent"
    >
      <option value="">{t('— No zone selected —')}</option>
      {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
    </select>
  );
}

function Slider({ label, value, min, max, unit, onChange, disabled }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className={`block py-1 ${disabled ? 'opacity-40' : ''}`}>
      <div className="flex text-ink-300">
        {t(label)}
        <span className="num ml-auto text-ink-100">{Math.round(value)} {t(unit)}</span>
      </div>
      <input type="range" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-cyan-400" />
    </label>
  );
}

function Delta({ label, before, after, unit, lowerIsBetter = false, digits = 1 }: { label: string; before: number; after: number; unit: string; lowerIsBetter?: boolean; digits?: number }): ReactNode {
  const diff = after - before;
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  const color = Math.abs(diff) < 1e-6 ? 'text-ink-400' : good ? 'text-emerald-400' : 'text-red-400';
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
      <div className="text-[10.5px] tracking-wider text-ink-300 uppercase">{t(label)}</div>
      <div className="num mt-1 flex items-baseline gap-1.5">
        <span className="text-ink-400 line-through decoration-ink-500">{fmt(before, digits)}</span>
        <span className="text-ink-400">→</span>
        <span className="text-xl font-semibold">{fmt(after, digits)}</span>
        <span className="text-ink-400">{t(unit)}</span>
      </div>
      <div className={`num text-[11px] ${color}`}>{diff >= 0 ? '+' : ''}{fmt(diff, digits)} {t(unit)} ({t('est.')})</div>
    </div>
  );
}
