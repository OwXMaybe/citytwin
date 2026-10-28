import { aqiBand, congestionBand, fmt, fmtInt, weatherCodeLabel } from '../lib/format';
import type { CityData } from '../hooks/useCityData';
import type { Provenance } from '../types/data';
import { energyAnomalies, pctOver, WHO } from './analysis';
import { AIR_PROVENANCE, WEATHER_PROVENANCE } from './openMeteo';
import { SIM_PROVENANCE } from './simulated';
import { t, locale } from '../i18n';

const GROUND_PROVENANCE: Provenance = { source: 'sensor', provider: 'Ground monitoring stations' };

/**
 * CityTwin AI — Phase 1 rule-based answer engine.
 * Intents are matched by keywords (English and Turkish); every answer is composed from values
 * already loaded in the client and cites the provenance of each value it uses. When a
 * question can't be answered from available data, it says so instead of guessing.
 * Since Phase 5 this is the fallback: when the backend has ANTHROPIC_API_KEY, the
 * assistant uses Claude with tools over the backend's data (services/aiChat.ts).
 */

export interface Answer {
  text: string;
  sources: Provenance[];
}

type Intent = { id: string; keywords: RegExp; run: (d: CityData) => Answer };

const INTENTS: Intent[] = [
  {
    id: 'summary',
    keywords: /summar|overview|status|situation|özet|durum|genel/i,
    run: (d) => {
      const parts: string[] = [t('Current status for {city}:', { city: d.city.name })];
      const sources: Provenance[] = [];
      if (d.weather.data) {
        parts.push(t('• Weather: {temp} °C, {sky}, humidity {hum}%.', { temp: fmt(d.weather.data.temperature.value), sky: weatherCodeLabel(d.weather.data.weatherCode).toLocaleLowerCase(locale()), hum: fmtInt(d.weather.data.humidity.value) }));
        sources.push(WEATHER_PROVENANCE);
      }
      if (d.air.data) {
        parts.push(t('• Air quality: European AQI {aqi} ({band}), PM2.5 {pm} µg/m³.', { aqi: fmtInt(d.air.data.aqi.value), band: aqiBand(d.air.data.aqi.value).label, pm: fmt(d.air.data.pm25.value) }));
        sources.push(AIR_PROVENANCE);
      }
      parts.push(t('• Traffic ({mode}): {index} {value}/100 — {band}.', {
        mode: d.liveTraffic.data ? `${t('live')} · ${t(d.liveTraffic.data.provenance.provider)}` : t('simulated'),
        index: t(d.liveTraffic.data?.indexLabel ?? 'congestion index'),
        value: d.congestionNow,
        band: congestionBand(d.congestionNow).label.toLocaleLowerCase(locale()),
      }));
      if (d.ground.count) parts.push(t('• Ground stations ({n}): PM10 {pm10}, PM2.5 {pm25} µg/m³ (measured medians).', { n: d.ground.count, pm10: fmt(d.ground.pm10.value), pm25: fmt(d.ground.pm25.value) }));
      parts.push(t('• Energy (simulated): {mwh} MWh/day across {n} zones.', { mwh: fmtInt(d.zones.reduce((s, z) => s + z.energyMWh, 0)), n: d.zones.length }));
      parts.push(t('• Alerts: {n} active', { n: d.alerts.length }) + (d.alerts.length ? ` (${d.alerts.map((a) => t(a.title)).join('; ')})` : '') + '.');
      if (d.liveTraffic.data) sources.push(d.trafficProvenance);
      if (d.ground.count) sources.push(GROUND_PROVENANCE);
      sources.push(SIM_PROVENANCE);
      return { text: parts.join('\n'), sources };
    },
  },
  {
    id: 'air',
    keywords: /air|pm2|pm10|no2|pollut|aqi|hava kalit|kirlil|partikül|toz/i,
    run: (d) => {
      if (!d.air.data) return unavailable('air quality', d.air.error);
      const a = d.air.data;
      const pm = a.history.map((p) => p.pm25 as number | null).filter((v): v is number => v != null);
      const max = pm.length ? Math.max(...pm) : null;
      const maxAt = max != null ? a.history.find((p) => p.pm25 === max)?.time : null;
      const g = d.ground;
      const groundText = g.count
        ? t('Measured at {n} ground stations (median of latest readings{lowcost}):', { n: g.count, lowcost: g.pm10.grade === 'low-cost' && g.pm25.grade === 'low-cost' ? t(', low-cost sensors — indicative') : '' }) + '\n' +
          [g.pm25.value != null ? `• PM2.5 ${fmt(g.pm25.value)} µg/m³ (n=${g.pm25.n})` : null, g.pm10.value != null ? `• PM10 ${fmt(g.pm10.value)} µg/m³ (n=${g.pm10.n})` : null, g.no2.value != null ? `• NO₂ ${fmt(g.no2.value)} µg/m³ (n=${g.no2.n})` : null].filter(Boolean).join('\n') +
          '\n\n'
        : t('No ground stations are reporting for {city}, so only model values are available.', { city: d.city.name }) + '\n\n';
      return {
        text:
          groundText +
          t('Regional model (CAMS, city centre):') + '\n' +
          t('• European AQI {aqi} — {band}.', { aqi: fmtInt(a.aqi.value), band: aqiBand(a.aqi.value).label }) + '\n' +
          t('• PM2.5 {pm25} µg/m³ (WHO 24 h guideline {who}), PM10 {pm10}, NO₂ {no2} µg/m³, CO₂ {co2} ppm.', { pm25: fmt(a.pm25.value), who: WHO.pm25_24h, pm10: fmt(a.pm10.value), no2: fmt(a.no2.value), co2: fmtInt(a.co2.value) }) + '\n' +
          (max != null && maxAt ? t('• Highest PM2.5 in the last 72 h: {max} µg/m³ at {when}.', { max: fmt(max), when: new Date(maxAt).toLocaleString(locale()) }) + '\n' : '') +
          t('Note: model values are at ~10–45 km resolution, not street-level readings.'),
        sources: g.count ? [GROUND_PROVENANCE, AIR_PROVENANCE] : [AIR_PROVENANCE],
      };
    },
  },
  {
    id: 'weather',
    keywords: /weather|temp|hot|cold|humid|wind|rain|sıcaklık|hava durumu|nem|rüzgar|yağmur|soğuk|sıcak/i,
    run: (d) => {
      if (!d.weather.data) return unavailable('weather', d.weather.error);
      const w = d.weather.data;
      const temps = w.history.map((p) => p.temperature as number | null).filter((v): v is number => v != null);
      return {
        text:
          t('Weather in {city}: {temp} °C (feels like {feels} °C), {sky}.', { city: d.city.name, temp: fmt(w.temperature.value), feels: fmt(w.apparentTemperature.value), sky: weatherCodeLabel(w.weatherCode).toLocaleLowerCase(locale()) }) + '\n' +
          t('Humidity {hum}%, wind {wind} km/h, pressure {p} hPa.', { hum: fmtInt(w.humidity.value), wind: fmt(w.windSpeed.value), p: fmtInt(w.pressure.value) }) + '\n' +
          (temps.length ? t('Over the last 48 h the temperature ranged {min}–{max} °C.', { min: fmt(Math.min(...temps)), max: fmt(Math.max(...temps)) }) : ''),
        sources: [WEATHER_PROVENANCE],
      };
    },
  },
  {
    id: 'traffic',
    keywords: /traffic|congest|road|jam|closure|bottleneck|trafik|yol|sıkışık|kapan/i,
    run: (d) => {
      const live = d.liveTraffic.data;
      const hourOf = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
      const valid = d.trafficHistory.filter((p) => typeof p.today === 'number');
      const peak = valid.reduce<(typeof valid)[number] | null>((m, p) => (!m || (p.today as number) > (m.today as number) ? p : m), null);
      const band = congestionBand(d.congestionNow).label.toLocaleLowerCase(locale());
      if (live) {
        const closures = d.incidents.filter((i) => i.kind === 'closure').length;
        const notGood = live.corridors.filter((c) => c.status !== 'Good').map((c) => `${c.name} (${t(c.status)})`).join(', ');
        return {
          text:
            t('Live traffic for {city} from {provider}', { city: d.city.name, provider: t(live.provenance.provider) }) + (live.stale ? ` ${t('(feed currently delayed)')}` : '') + ':\n' +
            `• ${t(live.indexLabel)}: ${d.congestionNow}/100 (${band})${live.indexSource === 'estimated' ? ` — ${t('derived by CityTwin from the feed')}` : ''}.\n` +
            live.subIndices.map((s) => `• ${t(s.label)}: ${s.value}\n`).join('') +
            (live.history && peak ? t('• Last 24 h peak: {v}/100 at {when}', { v: String(peak.today), when: hourOf(peak.time) }) + (typeof peak.lastWeek === 'number' ? ` (${t('same hour last week: {v}', { v: peak.lastWeek })})` : '') + '.\n' : '') +
            (live.corridors.length ? t('• Corridors not "Good": {list}.', { list: notGood || t('none') }) + '\n' : '') +
            (d.incidents.length ? t('• {n} live disruptions, {c} with closures.', { n: d.incidents.length, c: closures }) : t('• This feed publishes no incident data.')),
          sources: [d.trafficProvenance],
        };
      }
      const top = [...d.zones].sort((a, b) => b.trafficIndex - a.trafficIndex).slice(0, 3);
      return {
        text:
          t('Traffic in {city} is SIMULATED — no public live traffic feed is available for this city.', { city: d.city.name }) + '\n' +
          t('• Current congestion index {v}/100 ({band}).', { v: d.congestionNow, band }) + '\n' +
          t('• Most congested zones: {list}.', { list: top.map((z) => `${z.name} (${z.trafficIndex})`).join(', ') }) + '\n' +
          (peak ? t('• 24 h peak: {v}/100 at {when}.', { v: String(peak.today), when: hourOf(peak.time) }) + '\n' : '') +
          t('• {n} simulated incidents on the map.', { n: d.incidents.length }),
        sources: [SIM_PROVENANCE],
      };
    },
  },
  {
    id: 'energy',
    keywords: /energy|electric|power|consum|solar|renewable|enerji|elektrik|tüketim|güneş/i,
    run: (d) => {
      const an = energyAnomalies(d.zones);
      const total = d.zones.reduce((s, z) => s + z.energyMWh, 0);
      return {
        text:
          t('Energy data is SIMULATED.') + '\n' +
          t('• Total: {mwh} MWh/day across {n} zones.', { mwh: fmtInt(total), n: d.zones.length }) + '\n' +
          (an.length
            ? t('• Unusually high consumption (>20% above baseline): {list}.', { list: an.map((z) => `${z.name} +${fmt(pctOver(z), 0)}%`).join(', ') }) + '\n'
            : t('• No zone exceeds its baseline by more than 20%.') + '\n') +
          t('• Rooftop solar potential estimate: ~{v} kWh/m²·yr (latitude-based).', { v: fmtInt(d.zones[0]?.solarPotentialKWhm2) }),
        sources: [SIM_PROVENANCE],
      };
    },
  },
  {
    id: 'alerts',
    keywords: /alert|warning|problem|issue|anomal|unusual|uyarı|sorun|alarm|olağan/i,
    run: (d) => ({
      text: d.alerts.length
        ? t('Active alerts for {city}:', { city: d.city.name }) + '\n' + d.alerts.map((a) => `• [${t(a.severity).toLocaleUpperCase(locale())}] ${t(a.title)} — ${t(a.detail)} (${t(a.source)})`).join('\n')
        : t('No alerts are currently active for {city}.', { city: d.city.name }),
      sources: [...new Map(d.alerts.map((a) => [a.provider, a as Provenance])).values()],
    }),
  },
  {
    id: 'recommend',
    keywords: /recommend|suggest|improve|should|plan|öneri|öner|iyileştir|ne yap/i,
    run: (d) => {
      const recs: string[] = [];
      const sources: Provenance[] = [];
      if (d.air.data?.pm25.value != null && d.air.data.pm25.value > WHO.pm25_24h) {
        recs.push(t('PM2.5 is above the WHO guideline — consider low-emission zones or traffic calming in the most congested zones, and prioritise sensor deployment there to confirm local levels.'));
        sources.push(AIR_PROVENANCE);
      }
      const top = [...d.zones].sort((a, b) => b.trafficIndex - a.trafficIndex)[0];
      if (top && top.trafficIndex > 70) {
        recs.push(t('{zone} has the highest simulated congestion ({v}). Test an alternative route there in Urban Simulation before committing to studies.', { zone: top.name, v: top.trafficIndex }));
        sources.push(SIM_PROVENANCE);
      }
      const lowGreen = [...d.zones].sort((a, b) => a.greenShare - b.greenShare)[0];
      if (lowGreen) recs.push(t('{zone} has the lowest simulated green share ({v}%) — a candidate for greening; use the green-space slider to see the estimated cooling.', { zone: lowGreen.name, v: fmtInt(lowGreen.greenShare * 100) }));
      const an = energyAnomalies(d.zones);
      if (an.length) recs.push(t('Audit consumption in {list} (above baseline in simulated data).', { list: an.map((z) => z.name).join(', ') }));
      recs.push(t('Connect real traffic counts and IoT air/noise sensors so these recommendations can be based on measurements rather than simulated values.'));
      return { text: t('Suggestions (based on current data, for discussion — not engineering advice):') + '\n' + recs.map((r) => `• ${r}`).join('\n'), sources };
    },
  },
];

function unavailable(what: string, err: unknown): Answer {
  const reason = err instanceof Error ? ` (${t(err.message)})` : ` (${t('still loading')})`;
  return { text: t("I don't have {what} data available right now{reason}, so I can't answer that without guessing.", { what: t(what), reason }), sources: [] };
}

export function answer(question: string, d: CityData): Answer {
  const hits = INTENTS.filter((i) => i.keywords.test(question));
  if (!hits.length) {
    return {
      text:
        t('I can only answer from data loaded in CityTwin. Try asking about: a city summary, air quality, weather, traffic, energy, alerts, or improvement suggestions.') + '\n' +
        t('For free-form questions, enable Claude by setting ANTHROPIC_API_KEY on the backend.'),
      sources: [],
    };
  }
  const answers = hits.slice(0, 2).map((h) => h.run(d));
  return { text: answers.map((a) => a.text).join('\n\n'), sources: [...new Map(answers.flatMap((a) => a.sources).map((s) => [s.provider, s])).values()] };
}

export const SUGGESTED_QUESTIONS = [
  'Give me a summary of the city',
  'How is the air quality?',
  'Where is traffic worst?',
  'Any energy anomalies?',
  'What should we improve?',
];
