import type { AirGridPoint, City, Metric, Provenance, TimePoint } from '../types/data';

/**
 * Open-Meteo client. No API key required, CORS-enabled.
 * Weather: https://open-meteo.com/en/docs
 * Air quality: https://open-meteo.com/en/docs/air-quality-api (CAMS atmospheric model,
 * ~11 km resolution in Europe, ~45 km globally — these are model values, not street-level
 * sensor readings, and are labelled accordingly in the UI).
 */

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

export const WEATHER_PROVENANCE: Provenance = {
  source: 'external-api',
  provider: 'Open-Meteo Forecast API',
  note: 'Numerical weather model blend for the city centre coordinate.',
};

export const AIR_PROVENANCE: Provenance = {
  source: 'external-api',
  provider: 'Open-Meteo Air Quality (CAMS model)',
  note: 'Atmospheric model output (~11 km grid in Europe, ~45 km elsewhere). Not a ground sensor reading.',
};

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('Network error — the data provider could not be reached.');
  }
  if (!res.ok) {
    let reason = res.statusText;
    try {
      const body = (await res.json()) as { reason?: string };
      if (body.reason) reason = body.reason;
    } catch {
      /* ignore body parse errors */
    }
    throw new ApiError(`Provider returned ${res.status}: ${reason}`, res.status);
  }
  return (await res.json()) as T;
}

/** Open-Meteo returns GMT times without a zone suffix when no timezone is requested. */
const toIso = (t: string) => new Date(`${t}Z`).toISOString();

function hourlyToPoints(
  hourly: Record<string, (number | null)[] | string[]>,
  keys: Record<string, string>,
  until = Date.now(),
): TimePoint[] {
  const times = hourly.time as string[];
  const out: TimePoint[] = [];
  times.forEach((t, i) => {
    const iso = toIso(t);
    if (new Date(iso).getTime() > until) return;
    const p: TimePoint = { time: iso };
    for (const [apiKey, outKey] of Object.entries(keys)) {
      const arr = hourly[apiKey] as (number | null)[] | undefined;
      p[outKey] = arr?.[i] ?? null;
    }
    out.push(p);
  });
  return out;
}

// ---------------------------------------------------------------- weather

interface WeatherResponse {
  current: Record<string, number | string>;
  current_units: Record<string, string>;
  hourly: Record<string, (number | null)[] | string[]>;
}

export interface WeatherData {
  temperature: Metric;
  apparentTemperature: Metric;
  humidity: Metric;
  windSpeed: Metric;
  windDirection: Metric;
  pressure: Metric;
  precipitation: Metric;
  weatherCode: number | null;
  history: TimePoint[]; // temp, humidity, wind — past 48 h
  fetchedAt: string;
}

export async function fetchWeather(city: City, signal?: AbortSignal): Promise<WeatherData> {
  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    current:
      'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,precipitation',
    hourly: 'temperature_2m,relative_humidity_2m,wind_speed_10m',
    past_days: '2',
    forecast_days: '1',
  });
  const d = await getJson<WeatherResponse>(`${WEATHER_URL}?${params}`, signal);
  const ts = toIso(String(d.current.time));
  const m = (key: string): Metric => ({
    ...WEATHER_PROVENANCE,
    value: typeof d.current[key] === 'number' ? (d.current[key] as number) : null,
    unit: d.current_units[key] ?? '',
    timestamp: ts,
  });
  return {
    temperature: m('temperature_2m'),
    apparentTemperature: m('apparent_temperature'),
    humidity: m('relative_humidity_2m'),
    windSpeed: m('wind_speed_10m'),
    windDirection: m('wind_direction_10m'),
    pressure: m('surface_pressure'),
    precipitation: m('precipitation'),
    weatherCode: typeof d.current.weather_code === 'number' ? d.current.weather_code : null,
    history: hourlyToPoints(d.hourly, {
      temperature_2m: 'temperature',
      relative_humidity_2m: 'humidity',
      wind_speed_10m: 'wind',
    }).slice(-48),
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- air quality

interface AirResponse {
  latitude: number;
  longitude: number;
  current: Record<string, number | string | null>;
  current_units: Record<string, string>;
  hourly: Record<string, (number | null)[] | string[]>;
}

export interface AirData {
  aqi: Metric;
  pm25: Metric;
  pm10: Metric;
  no2: Metric;
  co: Metric;
  co2: Metric;
  ozone: Metric;
  history: TimePoint[]; // pm25, pm10, no2, aqi — past 72 h
  fetchedAt: string;
}

export async function fetchAirQuality(city: City, signal?: AbortSignal): Promise<AirData> {
  const params = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    current: 'european_aqi,pm2_5,pm10,nitrogen_dioxide,carbon_monoxide,carbon_dioxide,ozone',
    hourly: 'european_aqi,pm2_5,pm10,nitrogen_dioxide',
    past_days: '3',
    forecast_days: '1',
  });
  const d = await getJson<AirResponse>(`${AIR_URL}?${params}`, signal);
  const ts = toIso(String(d.current.time));
  const m = (key: string): Metric => ({
    ...AIR_PROVENANCE,
    value: typeof d.current[key] === 'number' ? (d.current[key] as number) : null,
    unit: d.current_units[key] ?? '',
    timestamp: ts,
  });
  return {
    aqi: m('european_aqi'),
    pm25: m('pm2_5'),
    pm10: m('pm10'),
    no2: m('nitrogen_dioxide'),
    co: m('carbon_monoxide'),
    co2: m('carbon_dioxide'),
    ozone: m('ozone'),
    history: hourlyToPoints(d.hourly, {
      european_aqi: 'aqi',
      pm2_5: 'pm25',
      pm10: 'pm10',
      nitrogen_dioxide: 'no2',
    }).slice(-72),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Samples the air-quality model on a regular grid around the city so the map can
 * render a regional heatmap. Spacing matches the model resolution — finer sampling
 * would only repeat identical cells.
 */
export async function fetchAirGrid(city: City, signal?: AbortSignal, extent?: [number, number, number, number]): Promise<AirGridPoint[]> {
  const n = 5;
  // Default: ~35 km square around the centre; otherwise span the given w,s,e,n extent.
  const [w, s, e, nn] = extent ?? [city.lon - 0.208, city.lat - 0.16, city.lon + 0.208, city.lat + 0.16];
  const lats: number[] = [];
  const lons: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      lats.push(+(s + ((nn - s) * i) / (n - 1)).toFixed(4));
      lons.push(+(w + ((e - w) * j) / (n - 1)).toFixed(4));
    }
  }
  const params = new URLSearchParams({
    latitude: lats.join(','),
    longitude: lons.join(','),
    current: 'european_aqi,pm2_5,pm10,nitrogen_dioxide',
  });
  const d = await getJson<AirResponse[] | AirResponse>(`${AIR_URL}?${params}`, signal);
  const arr = Array.isArray(d) ? d : [d];
  // Use the requested coordinates for display; the API echoes the snapped model cell.
  return arr.map((r, i) => ({
    lon: lons[i],
    lat: lats[i],
    pm25: (r.current.pm2_5 as number) ?? null,
    pm10: (r.current.pm10 as number) ?? null,
    no2: (r.current.nitrogen_dioxide as number) ?? null,
    aqi: (r.current.european_aqi as number) ?? null,
  }));
}
