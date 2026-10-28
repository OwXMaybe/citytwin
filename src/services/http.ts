/** Shared fetch helper for live feeds: timeout, abort, typed errors, proxy detection. */

export class FeedError extends Error {
  constructor(
    message: string,
    /** 'unavailable' = feed not configured here (no key / no proxy) rather than a failure. */
    readonly kind: 'network' | 'http' | 'unavailable' = 'network',
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, opts: { signal?: AbortSignal; timeoutMs?: number; init?: RequestInit } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(url, { ...opts.init, signal: ctrl.signal });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new FeedError(ctrl.signal.aborted ? 'Request timed out.' : 'Network error — the provider could not be reached.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  // Same-origin proxy paths fall through to index.html when no proxy is running.
  if (url.startsWith('/proxy/') && text.trimStart().startsWith('<')) {
    throw new FeedError('Proxy not available in this deployment (run `npm run dev` / `npm run preview`, or deploy the Phase 4 backend).', 'unavailable');
  }
  // 401 (no key upstream) and 503 (backend has no key configured) mean "not set up here".
  if (!res.ok) throw new FeedError(`Provider returned HTTP ${res.status}.`, res.status === 401 || res.status === 503 ? 'unavailable' : 'http', res.status);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FeedError('Provider returned an unreadable response.', 'http');
  }
}

/** Formats a Date as wall-clock time in a time zone, e.g. for APIs that expect local time. */
export function localParts(d: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { ...p, hour: p.hour === '24' ? '00' : p.hour } as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}

/** Parses a zone-less local timestamp ("2026-10-24T23:00:00") given the zone's current UTC offset. */
export function parseLocal(ts: string, timeZone: string): Date {
  const naive = new Date(`${ts.replace(' ', 'T')}Z`); // as if UTC
  const p = localParts(naive, timeZone);
  const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(naive.getTime() - (asLocal - naive.getTime()));
}

export const minutesAgo = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 60_000 : Infinity);
