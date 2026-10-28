import { useMemo } from 'react';
import { Download, Printer } from 'lucide-react';
import { Panel } from '../components/ui/Panel';
import { useCity } from '../hooks/CityDataContext';
import type { CityData } from '../hooks/useCityData';
import { aqiBand, congestionBand, fmt, fmtInt, weatherCodeLabel } from '../lib/format';
import { energyAnomalies, pctOver, WHO } from '../services/analysis';
import { estimateNoiseDb } from '../services/simulated';
import { t, locale } from '../i18n';

/** Generates a Markdown situation report from the currently loaded data. */
function buildReport(d: CityData): string {
  const now = new Date();
  const L: string[] = [];
  const none = t('none');
  L.push(`# ${t('CityTwin Situation Report — {city}, {country}', { city: d.city.name, country: t(d.city.country) })}`);
  L.push(t('Generated {when} · Analysis grid {area} km² ({n} zones)', { when: now.toLocaleString(locale()), area: fmt(d.areaKm2, 0), n: d.zones.length }));
  L.push('');
  L.push(`> ${t('Data provenance: [SENSOR] ground measurement, [API] external API (may be model data), [SIM] simulated demo data, [EST] CityTwin estimate.')}`);
  L.push('');
  L.push(`## 1. ${t('Environment')}`);
  if (d.weather.data) {
    const w = d.weather.data;
    L.push(`- [API] ${t('Temperature {temp} °C (feels {feels} °C), {sky}', { temp: fmt(w.temperature.value), feels: fmt(w.apparentTemperature.value), sky: weatherCodeLabel(w.weatherCode).toLocaleLowerCase(locale()) })}`);
    L.push(`- [API] ${t('Humidity {hum} %, wind {wind} km/h, pressure {p} hPa', { hum: fmtInt(w.humidity.value), wind: fmt(w.windSpeed.value), p: fmtInt(w.pressure.value) })}`);
  } else L.push(`- ${t('Weather data unavailable at time of report.')}`);
  if (d.air.data) {
    const a = d.air.data;
    L.push(`- [API] ${t('European AQI')} ${fmtInt(a.aqi.value)} (${aqiBand(a.aqi.value).label})`);
    L.push(`- [API] ${t('PM2.5 {pm25} µg/m³ (WHO 24 h guideline {who}), PM10 {pm10} µg/m³, NO₂ {no2} µg/m³, O₃ {o3} µg/m³, CO₂ {co2} ppm', { pm25: fmt(a.pm25.value), who: WHO.pm25_24h, pm10: fmt(a.pm10.value), no2: fmt(a.no2.value), o3: fmt(a.ozone.value), co2: fmtInt(a.co2.value) })}`);
  } else L.push(`- ${t('Air quality data unavailable at time of report.')}`);
  if (d.ground.count) {
    const g = d.ground;
    const fmtG = (label: string, s: typeof g.pm10) => (s.value != null ? `${label} ${fmt(s.value)} µg/m³ (n=${s.n}, ${t(s.grade)})` : null);
    L.push(`- [SENSOR] ${t('Ground stations ({n})', { n: g.count })}: ${[fmtG('PM2.5', g.pm25), fmtG('PM10', g.pm10), fmtG('NO₂', g.no2)].filter(Boolean).join(', ')} — ${t('medians of latest readings')}`);
    for (const s of d.stations.data?.sources ?? []) if (s.state === 'ok') L.push(`  - ${t(s.label)}: ${t(s.detail)}`);
  } else {
    L.push(`- ${t('No ground monitoring stations reporting; environment values above are model data.')}`);
  }
  L.push('');
  const live = d.liveTraffic.data;
  if (live) {
    const tag = live.indexSource === 'external-api' ? '[API]' : `[${t('EST from live feed')}]`;
    L.push(`## 2. ${t('Traffic')} [${t('LIVE')} · ${t(live.provenance.provider)}]`);
    L.push(`- ${tag} ${t(live.indexLabel)}: ${d.congestionNow}/100 (${congestionBand(d.congestionNow).label})${live.stale ? ` — ${t('feed delayed')}` : ''}, ${t('as of {when}', { when: live.asOf ? new Date(live.asOf).toLocaleString(locale()) : t('unknown') })}`);
    live.subIndices.forEach((s) => L.push(`- ${t(s.label)}: ${s.value}`));
    const bad = live.corridors.filter((c) => c.status !== 'Good');
    if (live.corridors.length) L.push(`- ${t('Corridors with delays')}: ${bad.length ? bad.map((c) => `${c.name} (${t(c.status)})`).join(', ') : none}`);
    if (d.incidents.length) L.push(`- ${t('Live disruptions: {n} ({c} with closures)', { n: d.incidents.length, c: d.incidents.filter((i) => i.kind === 'closure').length })}`);
    if (!live.segments) L.push(`- [SIM] ${t('Per-road congestion is simulated, scaled to the live city index.')}`);
  } else {
    L.push(`## 2. ${t('Traffic')} [SIM]`);
    L.push(`- ${t('No public live traffic feed for this city; values are simulated.')}`);
    L.push(`- ${t('City congestion index {v}/100 ({band})', { v: d.congestionNow, band: congestionBand(d.congestionNow).label })}`);
    const topT = [...d.zones].sort((a, b) => b.trafficIndex - a.trafficIndex).slice(0, 5);
    L.push(`- ${t('Most congested zones')}: ${topT.map((z) => `${z.name} (${z.trafficIndex})`).join(', ')}`);
    L.push(`- ${t('Incidents')}: ${d.incidents.map((i) => t(i.title)).join('; ')}`);
  }
  L.push('');
  L.push(`## 3. ${t('Energy')} [SIM]`);
  L.push(`- ${t('Total consumption {v} MWh/day', { v: fmtInt(d.zones.reduce((s, z) => s + z.energyMWh, 0)) })}`);
  const an = energyAnomalies(d.zones);
  L.push(`- ${t('Zones >20% above baseline')}: ${an.length ? an.map((z) => `${z.name} (+${fmt(pctOver(z))}%)`).join(', ') : none}`);
  L.push('');
  L.push(`## 4. ${t('Zone table')}`);
  L.push(`| ${t('Zone')} | ${t('Traffic')} [SIM] | ${t('Energy MWh/d')} [SIM] | ${t('vs baseline')} | ${t('Green')} [SIM] | ${t('Noise dB(A)')} [EST] |`);
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const z of d.zones) L.push(`| ${z.name} | ${z.trafficIndex} | ${fmt(z.energyMWh)} | ${fmt(pctOver(z))}% | ${fmtInt(z.greenShare * 100)}% | ${fmt(estimateNoiseDb(z.trafficIndex))} |`);
  L.push('');
  L.push(`## 5. ${t('Alerts')}`);
  if (d.alerts.length) d.alerts.forEach((a) => L.push(`- **${t(a.severity).toLocaleUpperCase(locale())}** ${t(a.title)} — ${t(a.detail)} _(${t('source')}: ${t(a.provider)})_`));
  else L.push(`- ${t('No active alerts.')}`);
  L.push('');
  L.push(`## 6. ${t('Insights')} [${t('rule engine')}]`);
  d.insights.forEach((i) => L.push(`- ${t(i.text)} _(${t('source')}: ${t(i.provider)})_`));
  L.push('');
  L.push('---');
  L.push(t('Sources: Open-Meteo (weather, CAMS air quality), İBB / Sensor.Community / OpenAQ (ground stations, where available), İBB / TfL / NYC DOT (live traffic, where available), © OpenStreetMap contributors via OpenFreeMap, CityTwin synthetic generator.'));
  return L.join('\n');
}

export function ReportsPage() {
  const d = useCity();
  const md = useMemo(() => buildReport(d), [d]);
  const download = () => {
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `citytwin-${d.city.id}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="no-print mb-3 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold">{t('Reports')} · {d.city.name}</h1>
          <p className="text-ink-400">{t('Situation report generated from the data currently loaded. Every value is tagged with its source.')}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={download} className="flex items-center gap-1.5 rounded border border-accent/50 bg-accent/10 px-3 py-1.5 text-accent hover:bg-accent/20">
            <Download className="size-3.5" /> {t('Download .md')}
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 rounded border border-ink-600 px-3 py-1.5 text-ink-200 hover:border-ink-500">
            <Printer className="size-3.5" /> {t('Print / PDF')}
          </button>
        </div>
      </div>
      <Panel title="Report preview" bodyClassName="p-4">
        <pre className="num text-[12px] leading-relaxed whitespace-pre-wrap text-ink-200">{md}</pre>
      </Panel>
    </div>
  );
}
