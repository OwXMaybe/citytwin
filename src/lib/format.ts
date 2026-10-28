import { t, locale } from '../i18n';
export const fmt = (v: number | null | undefined, digits = 1) =>
  v == null || Number.isNaN(v)
    ? '—'
    : v.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const fmtInt = (v: number | null | undefined) =>
  v == null || Number.isNaN(v) ? '—' : Math.round(v).toLocaleString(locale());

export const hourLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

export const dayHourLabel = (iso: string) =>
  new Date(iso).toLocaleString(locale(), { weekday: 'short', hour: '2-digit' });

/** European AQI bands (EEA). */
export function aqiBand(aqi: number | null): { label: string; color: string } {
  if (aqi == null) return { label: t('No data'), color: '#64748b' };
  if (aqi <= 20) return { label: t('Good'), color: '#22c55e' };
  if (aqi <= 40) return { label: t('Fair'), color: '#84cc16' };
  if (aqi <= 60) return { label: t('Moderate'), color: '#eab308' };
  if (aqi <= 80) return { label: t('Poor'), color: '#f97316' };
  if (aqi <= 100) return { label: t('Very poor'), color: '#ef4444' };
  return { label: t('Extremely poor'), color: '#a855f7' };
}

export function congestionBand(v: number): { label: string; color: string } {
  if (v < 30) return { label: t('Free flow'), color: '#22c55e' };
  if (v < 55) return { label: t('Moderate'), color: '#eab308' };
  if (v < 75) return { label: t('Heavy'), color: '#f97316' };
  return { label: t('Severe'), color: '#ef4444' };
}

export function weatherCodeLabel(code: number | null): string {
  if (code == null) return '—';
  const map: Record<number, string> = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
    95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
  };
  return map[code] != null ? t(map[code]) : t('Code {code}', { code });
}
