/**
 * Data provenance is a first-class concept in CityTwin. Every value shown in the
 * UI carries a `source` so users can tell real measurements from model output,
 * simulations and estimates.
 */
export type DataSource =
  | 'sensor' // physical IoT / station measurement
  | 'external-api' // third-party API (may itself be model-based, see `provider`)
  | 'simulated' // synthetic data generated for development / demo
  | 'estimated'; // derived by CityTwin from other values with a simple model

export interface Provenance {
  source: DataSource;
  provider: string; // e.g. "Open-Meteo (CAMS model)", "CityTwin synthetic generator"
  note?: string;
}

export interface Metric extends Provenance {
  value: number | null;
  unit: string;
  timestamp: string; // ISO
}

export interface TimePoint {
  time: string; // ISO
  [series: string]: number | string | null;
}

export interface City {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  zoom: number;
  timezone: string;
}

export type ZoneGeometry =
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] };

export interface Zone {
  id: string;
  name: string;
  /** 'district' = real OSM administrative boundary; 'grid' = synthetic hex fallback. */
  kind: 'district' | 'grid';
  osmId: number | null;
  center: [number, number]; // lon, lat
  geometry: ZoneGeometry;
  areaKm2: number;
  population: number;
  populationSource: 'osm' | 'simulated';
  trafficIndex: number; // 0..100, simulated
  energyMWh: number; // daily, simulated
  energyBaselineMWh: number; // simulated baseline for anomaly detection
  greenShare: number; // 0..1, simulated
  solarPotentialKWhm2: number; // annual, estimated from latitude
}

/** Output of pipeline/import-districts.ts (public/data/districts/<city>.geojson). */
export interface DistrictCollection {
  type: 'FeatureCollection';
  metadata: { cityId: string; source: string; unit: string; adminLevel: number; osmTimestamp: string | null; importedAt: string; simplifiedToleranceM: number; servedBy?: 'PostGIS' };
  features: {
    type: 'Feature';
    id: number;
    geometry: ZoneGeometry;
    properties: {
      osmId: number;
      name: string;
      nameEn: string | null;
      population: number | null;
      populationDate: string | null;
      wikidata: string | null;
      areaKm2: number;
      center: [number, number];
    };
  }[];
}

export interface AirGridPoint {
  lon: number;
  lat: number;
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  aqi: number | null;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface CityAlert extends Provenance {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  module: 'environment' | 'traffic' | 'energy' | 'system';
  time: string;
}

/** A road incident — from a live feed (`live: true`) or the simulation. */
export interface TrafficIncident {
  id: string;
  kind: 'closure' | 'bottleneck' | 'disruption';
  lon: number;
  lat: number;
  title: string;
  detail?: string;
  severity?: string;
  live: boolean;
}

export type Selection =
  | { kind: 'building'; lon: number; lat: number; props: Record<string, unknown> }
  | { kind: 'road'; lon: number; lat: number; props: Record<string, unknown>; congestion: number }
  | { kind: 'station'; stationId: string }
  | { kind: 'incident'; incidentId: string }
  | { kind: 'zone'; zoneId: string }
  | { kind: 'place'; lon: number; lat: number; label: string }
  | null;
