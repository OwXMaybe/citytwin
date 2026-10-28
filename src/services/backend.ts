/**
 * CityTwin backend (Phase 4) discovery. The frontend works in two modes:
 *   - backend: PostGIS districts, cached upstream proxies, server-side sensor polling + WebSocket
 *   - direct:  Phase 1–3 behaviour (static district files, dev-server proxies, browser polling)
 * Mode is decided by a cheap health check, re-checked every 30 s.
 */

export interface BackendInfo {
  ok: boolean;
  version: string;
  postgis: string;
  districts: number;
  readings: number;
  openaq: boolean;
  poller: { enabled: boolean; lastRun: Record<string, string> };
  websocketClients: number;
  /** Phase 5: Claude-backed assistant; absent on older backends. */
  ai?: { enabled: boolean; model: string | null; effort: string };
}

const HEALTH_TTL = 30_000;
let cached: { at: number; value: Promise<BackendInfo | null> } | null = null;

export function getBackend(force = false): Promise<BackendInfo | null> {
  if (!force && cached && Date.now() - cached.at < HEALTH_TTL) return cached.value;
  const value = (async () => {
    try {
      const res = await fetch('/api/v1/health', { signal: AbortSignal.timeout(2500) });
      if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
      const info = (await res.json()) as BackendInfo;
      return info.ok ? info : null;
    } catch {
      return null;
    }
  })();
  cached = { at: Date.now(), value };
  return value;
}

/** Base URL for a proxied upstream: backend route when available, else the Vite dev proxy. */
export async function upstreamBase(name: 'ibb-traffic' | 'ibb-air' | 'openaq'): Promise<string> {
  return (await getBackend()) ? `/api/v1/proxy/${name}` : `/proxy/${name}`;
}

export function sensorSocketUrl(cityId: string) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/sensors?city=${encodeURIComponent(cityId)}`;
}
