/**
 * Overpass API client with mirror fallback, per-request timeout and backoff.
 * Shared by the browser and the Node pipeline (explicit `.ts` imports, erasable TS only).
 * Public Overpass instances are fair-use and often saturated — callers must handle errors.
 */
import type { OverpassElement } from './geometry.ts';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface OverpassResult {
  elements: OverpassElement[];
  endpoint: string;
  timestamp: string | null; // OSM data timestamp reported by the server
}

export interface OverpassOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  rounds?: number; // passes over the endpoint list
  onAttempt?: (endpoint: string, attempt: number) => void;
  userAgent?: string; // Node only; browsers set their own
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

export async function runOverpass(query: string, opts: OverpassOptions = {}): Promise<OverpassResult> {
  const { signal, timeoutMs = 60_000, rounds = 2, onAttempt } = opts;
  const errors: string[] = [];
  let attempt = 0;
  for (let round = 0; round < rounds; round++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      onAttempt?.(endpoint, ++attempt);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      signal?.addEventListener('abort', () => ctrl.abort());
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
        if (opts.userAgent) headers['User-Agent'] = opts.userAgent;
        const res = await fetch(endpoint, { method: 'POST', body: `data=${encodeURIComponent(query)}`, headers, signal: ctrl.signal });
        const text = await res.text();
        if (!res.ok || !text.trimStart().startsWith('{')) {
          errors.push(`${new URL(endpoint).host}: HTTP ${res.status}`);
          continue;
        }
        const json = JSON.parse(text) as { elements: OverpassElement[]; osm3s?: { timestamp_osm_base?: string }; remark?: string };
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
          errors.push(`${new URL(endpoint).host}: ${json.remark.slice(0, 80)}`);
          continue;
        }
        return { elements: json.elements, endpoint, timestamp: json.osm3s?.timestamp_osm_base ?? null };
      } catch (e) {
        if (signal?.aborted) throw e;
        errors.push(`${new URL(endpoint).host}: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (round < rounds - 1) await sleep(2000 * 2 ** round, signal);
  }
  throw new Error(`All Overpass servers are busy or unreachable (${errors.slice(-3).join('; ')}). Try again in a minute.`);
}
