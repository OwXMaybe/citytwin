import { aqiBand, congestionBand, fmt } from '../lib/format';
import type { AirGridPoint, City, CityAlert, Provenance, TimePoint, Zone } from '../types/data';
import type { AirData, WeatherData } from './openMeteo';
import { AIR_PROVENANCE, WEATHER_PROVENANCE } from './openMeteo';
import { SIM_PROVENANCE } from './simulated';
import type { GroundSummary } from './air/stations';
import type { LiveIncident } from './traffic/live';
import { t, locale } from '../i18n';

/**
 * Rule-based analysis engine. It only restates and compares values that exist in
 * the loaded data — it never generates numbers of its own. Phase 5 adds an LLM layer
 * on top that receives the same structured context.
 */

export const ENGINE_PROVENANCE: Provenance = {
  source: 'estimated',
  provider: 'CityTwin rule engine',
  note: 'Deterministic rules over loaded data. With a Claude key on the backend, the AI Assistant uses Claude instead.',
};

/** WHO 2021 air quality guideline values (µg/m³). */
export const WHO = { pm25_24h: 15, pm10_24h: 45, no2_24h: 25 };

interface Ctx {
  city: City;
  weather?: WeatherData;
  air?: AirData;
  zones: Zone[];
  congestionNow: number;
  /** Ground-station medians (real measurements) — preferred over the model when present. */
  ground: { pm25: GroundSummary; pm10: GroundSummary; no2: GroundSummary; count: number };
  /** Live feed provenance when the city has one, otherwise the simulation. */
  trafficProvenance: Provenance;
}

const GROUND: Provenance = { source: 'sensor', provider: 'Ground monitoring stations', note: 'Median across reporting stations (reference monitors preferred over low-cost sensors).' };

export function deriveAlerts(ctx: Ctx & { weatherError: Error | null; airError: Error | null; liveIncidents: LiveIncident[] }): CityAlert[] {
  const now = new Date().toISOString();
  const out: CityAlert[] = [];
  const { air, weather, ground } = ctx;

  // Ground measurements first; the model alerts below are skipped for pollutants measured here.
  const measured = new Set<string>();
  const groundAlert = (key: 'pm25' | 'pm10' | 'no2', label: string, limit: number) => {
    const g = ground[key];
    if (g.value == null) return;
    measured.add(key);
    if (g.value > limit) {
      out.push({ ...GROUND, id: `ground-${key}`, severity: g.value > limit * 2 ? 'critical' : 'warning', module: 'environment', time: now, title: t('{p} above WHO guideline (measured)', { p: label }), detail: t('Median {v} µg/m³ across {n} {grade} stations vs 24 h guideline {limit} µg/m³ (latest hourly values, indicative).', { v: fmt(g.value), n: g.n, grade: t(g.grade), limit }) });
    }
  };
  groundAlert('pm25', 'PM2.5', WHO.pm25_24h);
  groundAlert('pm10', 'PM10', WHO.pm10_24h);
  groundAlert('no2', 'NO₂', WHO.no2_24h);

  const serious = ctx.liveIncidents.filter((i) => /serious|severe/i.test(i.severity) || i.kind === 'closure');
  if (serious.length) {
    out.push({ ...ctx.trafficProvenance, id: 'live-incidents', severity: 'warning', module: 'traffic', time: now, title: t('{n} serious road disruptions / closures', { n: serious.length }), detail: serious.slice(0, 3).map((i) => t(i.title)).join('; ') });
  }

  if (ctx.weatherError) {
    out.push({ ...SYSTEM, id: 'feed-weather', severity: 'warning', module: 'system', time: now, title: t('Weather feed unavailable'), detail: t(ctx.weatherError.message) });
  }
  if (ctx.airError) {
    out.push({ ...SYSTEM, id: 'feed-air', severity: 'warning', module: 'system', time: now, title: t('Air quality feed unavailable'), detail: t(ctx.airError.message) });
  }

  if (air) {
    const aqi = air.aqi.value;
    if (aqi != null && aqi > 60) {
      out.push({ ...AIR_PROVENANCE, id: 'aqi', severity: aqi > 80 ? 'critical' : 'warning', module: 'environment', time: air.aqi.timestamp, title: t('Air quality: {band}', { band: aqiBand(aqi).label.toLocaleLowerCase(locale()) }), detail: t('European AQI {aqi} at the city centre.', { aqi }) });
    }
    const pm25 = air.pm25.value;
    if (!measured.has('pm25') && pm25 != null && pm25 > WHO.pm25_24h) {
      out.push({ ...AIR_PROVENANCE, id: 'pm25', severity: pm25 > WHO.pm25_24h * 2 ? 'critical' : 'warning', module: 'environment', time: air.pm25.timestamp, title: t('PM2.5 above WHO guideline (model)'), detail: t('{v} µg/m³ vs 24 h guideline of {limit} µg/m³ (hourly value, indicative).', { v: fmt(pm25), limit: WHO.pm25_24h }) });
    }
    const no2 = air.no2.value;
    if (!measured.has('no2') && no2 != null && no2 > WHO.no2_24h) {
      out.push({ ...AIR_PROVENANCE, id: 'no2', severity: 'info', module: 'environment', time: air.no2.timestamp, title: t('NO₂ above WHO guideline'), detail: t('{v} µg/m³ vs 24 h guideline of {limit} µg/m³.', { v: fmt(no2), limit: WHO.no2_24h }) });
    }
  }
  if (weather) {
    const temp = weather.temperature.value;
    if (temp != null && temp >= 35) out.push({ ...WEATHER_PROVENANCE, id: 'heat', severity: 'critical', module: 'environment', time: weather.temperature.timestamp, title: t('Extreme heat'), detail: t('{v} °C at the city centre.', { v: fmt(temp) }) });
    if (temp != null && temp <= -5) out.push({ ...WEATHER_PROVENANCE, id: 'cold', severity: 'warning', module: 'environment', time: weather.temperature.timestamp, title: t('Severe cold'), detail: t('{v} °C at the city centre.', { v: fmt(temp) }) });
    const w = weather.windSpeed.value;
    if (w != null && w >= 50) out.push({ ...WEATHER_PROVENANCE, id: 'wind', severity: 'warning', module: 'environment', time: weather.windSpeed.timestamp, title: t('Strong wind'), detail: t('{v} km/h sustained wind.', { v: fmt(w) }) });
  }

  if (ctx.congestionNow >= 70) {
    out.push({ ...ctx.trafficProvenance, id: 'traffic', severity: 'warning', module: 'traffic', time: now, title: t('City congestion: {band}', { band: congestionBand(ctx.congestionNow).label.toLocaleLowerCase(locale()) }), detail: t('Congestion index {v}/100.', { v: ctx.congestionNow }) });
  }
  for (const z of energyAnomalies(ctx.zones)) {
    out.push({ ...SIM_PROVENANCE, id: `energy-${z.id}`, severity: 'info', module: 'energy', time: now, title: t('High consumption in {zone}', { zone: z.name }), detail: t('{v} MWh/day, {p}% above baseline.', { v: fmt(z.energyMWh), p: fmt(pctOver(z)) }) });
  }
  return out;
}

const SYSTEM: Provenance = { source: 'estimated', provider: 'CityTwin platform' };

export const pctOver = (z: Zone) => (z.energyMWh / z.energyBaselineMWh - 1) * 100;

export function energyAnomalies(zones: Zone[], threshold = 20) {
  return zones.filter((z) => pctOver(z) > threshold).sort((a, b) => pctOver(b) - pctOver(a));
}

export interface Insight extends Provenance {
  id: string;
  text: string;
}

export function deriveInsights(ctx: Ctx & { trafficHistory: TimePoint[]; stationHistory: TimePoint[] }): Insight[] {
  const out: Insight[] = [];
  const { air, weather, ground } = ctx;
  if (ground.pm10.value != null || ground.pm25.value != null) {
    const parts = [
      ground.pm25.value != null ? `PM2.5 ${fmt(ground.pm25.value)}` : null,
      ground.pm10.value != null ? `PM10 ${fmt(ground.pm10.value)}` : null,
      ground.no2.value != null ? `NO₂ ${fmt(ground.no2.value)}` : null,
    ].filter(Boolean);
    const model = air?.pm10.value;
    const cmp = ground.pm10.value != null && model != null ? ' ' + t(Math.abs(ground.pm10.value - model) / Math.max(model, 1) < 0.25 ? 'The CAMS model shows PM10 {v} µg/m³ — close to the ground median.' : ground.pm10.value > model ? 'The CAMS model shows PM10 {v} µg/m³ — below the ground median.' : 'The CAMS model shows PM10 {v} µg/m³ — above the ground median.', { v: fmt(model) }) : '';
    out.push({ ...GROUND, id: 'ground-now', text: t('{n} ground stations report median {list} µg/m³.', { n: ground.count, list: parts.join(', ') }) + cmp });
  }
  const pmHist = ctx.stationHistory.map((p) => p.pm10 as number | null).filter((v): v is number => v != null);
  if (pmHist.length >= 24) {
    const max = Math.max(...pmHist.slice(-24));
    out.push({ ...GROUND, id: 'ground-peak', text: t('Measured network-median PM10 peaked at {v} µg/m³ in the last 24 h.', { v: fmt(max) }) });
  }
  if (air?.history.length) {
    const vals = air.history.map((p) => p.pm25 as number | null).filter((v): v is number => v != null);
    const last24 = vals.slice(-24);
    const prev24 = vals.slice(-48, -24);
    if (last24.length && prev24.length) {
      const a = avg(last24);
      const b = avg(prev24);
      const d = ((a - b) / b) * 100;
      out.push({ ...AIR_PROVENANCE, id: 'pm-trend', text: Math.abs(d) < 5 ? t('PM2.5 averaged {v} µg/m³ over the last 24 h, roughly unchanged from the previous 24 h.', { v: fmt(a) }) : t(d > 0 ? 'PM2.5 averaged {v} µg/m³ over the last 24 h, {p}% higher than the previous 24 h.' : 'PM2.5 averaged {v} µg/m³ over the last 24 h, {p}% lower than the previous 24 h.', { v: fmt(a), p: fmt(Math.abs(d), 0) }) });
    }
    const hoursOver = last24.filter((v) => v > WHO.pm25_24h).length;
    if (hoursOver) out.push({ ...AIR_PROVENANCE, id: 'pm-hours', text: t('{n} of the last 24 hourly PM2.5 values exceeded the WHO 24 h guideline level ({limit} µg/m³).', { n: hoursOver, limit: WHO.pm25_24h }) });
  }
  if (weather?.history.length) {
    const temps = weather.history.map((p) => p.temperature as number | null).filter((v): v is number => v != null).slice(-24);
    if (temps.length) out.push({ ...WEATHER_PROVENANCE, id: 'temp-range', text: t('Temperature ranged from {min} to {max} °C over the last 24 h.', { min: fmt(Math.min(...temps)), max: fmt(Math.max(...temps)) }) });
  }
  const valid = ctx.trafficHistory.filter((p) => typeof p.today === 'number');
  const peak = valid.reduce<TimePoint | null>((m, p) => (!m || (p.today as number) > (m.today as number) ? p : m), null);
  const isLive = ctx.trafficProvenance.source !== 'simulated';
  if (peak) out.push({ ...ctx.trafficProvenance, id: 'traffic-peak', text: t(isLive ? 'Measured congestion peaked at {v}/100 around {when}' : 'Simulated congestion peaked at {v}/100 around {when}', { v: String(peak.today), when: new Date(peak.time).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) }) + (typeof peak.lastWeek === 'number' ? ` (${t('same hour last week: {v}', { v: peak.lastWeek })})` : '') + '.' });
  const anomalies = energyAnomalies(ctx.zones);
  if (anomalies.length) out.push({ ...SIM_PROVENANCE, id: 'energy-anom', text: t('{n} zones show consumption >20% above baseline: {list}.', { n: anomalies.length, list: anomalies.map((z) => z.name).join(', ') }) });
  return out;
}

export const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export const AIR_INTERP_PROVENANCE: Provenance = {
  source: 'estimated',
  provider: 'IDW interpolation of Open-Meteo CAMS grid',
  note: 'Zone values are inverse-distance weighted from the regional model grid. They show regional gradients, not street-level variation.',
};

/** Inverse-distance-weighted PM2.5 / AQI per zone from the model sample grid. */
export function interpolateAir(zones: Zone[], grid: AirGridPoint[]): Record<string, { pm25: number | null; aqi: number | null }> {
  const out: Record<string, { pm25: number | null; aqi: number | null }> = {};
  for (const z of zones) {
    let wSum = 0, pm = 0, aq = 0, wAq = 0;
    for (const g of grid) {
      const d2 = (g.lon - z.center[0]) ** 2 + (g.lat - z.center[1]) ** 2 + 1e-9;
      const w = 1 / d2;
      if (g.pm25 != null) { pm += w * g.pm25; wSum += w; }
      if (g.aqi != null) { aq += w * g.aqi; wAq += w; }
    }
    out[z.id] = { pm25: wSum ? pm / wSum : null, aqi: wAq ? aq / wAq : null };
  }
  return out;
}
