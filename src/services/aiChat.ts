/**
 * CityTwin AI client (Phase 5). The backend runs a Claude agent whose tools query
 * PostGIS and the cached feeds; this streams its events (server-sent events over a
 * POST) so the page can show tool calls and text as they happen.
 */
import type { Provenance } from '../types/data';

export type ChatEvent =
  | { type: 'text'; step: number; text: string }
  | { type: 'tool_start'; step: number; id: string; name: string }
  | { type: 'tool_use'; step: number; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; step: number; id: string; name: string; ok: boolean; provenance: Provenance | null }
  | { type: 'fallback'; step: number; from: string | null; to: string | null }
  | { type: 'retry'; step: number }
  | { type: 'refusal'; step: number; category: string | null }
  | { type: 'error'; message: string }
  | { type: 'done'; model: string; stopReason: string | null; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export const TOOL_LABEL: Record<string, string> = {
  get_city_overview: 'City overview',
  list_districts: 'Districts',
  find_district: 'District lookup',
  get_air_stations: 'Air stations',
  get_air_by_district: 'Air by district',
  get_air_history: 'Air history',
  get_station_history: 'Station history',
  get_anomalies: 'Anomalies',
  get_weather: 'Weather & air model',
  get_traffic: 'Live traffic',
};

export async function streamChat(city: string, messages: ChatTurn[], onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/api/v1/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ city, messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const d = ((await res.json()) as { detail?: unknown }).detail;
      if (typeof d === 'string') detail = d;
      else if (Array.isArray(d)) detail = d.map((x: { msg?: string }) => x.msg ?? '').filter(Boolean).join('; ') || detail; // FastAPI 422
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)) as ChatEvent);
      }
    }
  }
}
