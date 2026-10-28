/**
 * Phase 5 anomaly detection results from the backend (backend/app/services/anomalies.py).
 * The readings are real measurements; whether they are anomalous is a statistical
 * estimate, so everything here carries `source: 'estimated'`.
 */
import type { CityAlert, Provenance } from '../types/data';
import { fetchJson } from './http';
import { t } from '../i18n';

export type AnomalyKind = 'spike' | 'local-hotspot' | 'sensor-fault';
export type AnomalySeverity = 'info' | 'warning' | 'critical';

export interface Anomaly {
  sensorId: string;
  sensorName: string;
  provider: string;
  grade: 'reference' | 'low-cost';
  district: string | null;
  lon: number;
  lat: number;
  pollutant: 'pm25' | 'pm10' | 'no2';
  unit: string;
  value: number;
  expected: number | null;
  hour: string;
  zTemporal: number | null;
  zSpatial: number | null;
  ifScore: number | null;
  kind: AnomalyKind;
  severity: AnomalySeverity;
  explanation: string;
}

export interface Episode {
  pollutant: string;
  value: number;
  expected: number;
  z: number;
  stations: number;
  severity: AnomalySeverity;
  explanation: string;
}

export interface AnomalyResult {
  city: string;
  generatedAt: string;
  anomalies: Anomaly[];
  episodes: Episode[];
  coverage: Record<string, { stations: number; withHistory: number; withNeighbours: number; isolationForest: boolean }>;
  method: { features: string[]; model: string; thresholds: Record<string, unknown>; limitations: string };
  provenance: Provenance;
  recent: { sensorId: string; sensorName: string; pollutant: string; hour: string; kind: AnomalyKind; severity: AnomalySeverity; value: number; expected: number | null; explanation: string }[];
}

export const ANOMALY_PROVENANCE: Provenance = {
  source: 'estimated',
  provider: 'CityTwin anomaly detector',
  note: 'Measured station readings scored with robust z-scores (own 48 h history, nearest neighbours) and an IsolationForest. The readings are real; the anomaly judgement is a statistical estimate.',
};

export const POLLUTANT_LABEL: Record<string, string> = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂' };
export const KIND_LABEL: Record<AnomalyKind, string> = { spike: 'Spike', 'local-hotspot': 'Local hotspot', 'sensor-fault': 'Sensor fault' };

export function fetchAnomalies(cityId: string, signal?: AbortSignal): Promise<AnomalyResult> {
  return fetchJson<AnomalyResult>(`/api/v1/cities/${encodeURIComponent(cityId)}/anomalies`, { signal });
}

/** Warning/critical anomalies and city-wide episodes become dashboard alerts. */
export function anomalyAlerts(r: AnomalyResult | undefined): CityAlert[] {
  if (!r) return [];
  const alerts: CityAlert[] = r.episodes.map((e) => ({
    ...ANOMALY_PROVENANCE,
    id: `episode-${e.pollutant}`,
    severity: e.severity,
    title: t('City-wide {p} episode', { p: POLLUTANT_LABEL[e.pollutant] ?? e.pollutant }),
    detail: t(e.explanation),
    module: 'environment',
    time: r.generatedAt,
  }));
  for (const a of r.anomalies) {
    if (a.severity === 'info') continue;
    alerts.push({
      ...ANOMALY_PROVENANCE,
      id: `anomaly-${a.sensorId}-${a.pollutant}`,
      severity: a.severity,
      title: t('{kind}: {p} at {name}', { kind: t(KIND_LABEL[a.kind]), p: POLLUTANT_LABEL[a.pollutant], name: a.sensorName }) + (a.district ? ` (${a.district})` : ''),
      detail: `${t(a.explanation)}${a.grade === 'low-cost' ? ` ${t('Low-cost sensor — indicative only.')}` : ''}`,
      module: 'environment',
      time: a.hour,
    });
  }
  return alerts.slice(0, 8);
}
