import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { sensorSocketUrl } from '../services/backend';
import type { StationFeed } from '../services/air/stations';
import type { AnomalyResult } from '../services/anomalies';

export type SocketState = 'off' | 'connecting' | 'open' | 'closed';

/**
 * Subscribes to the backend's live sensor stream for a city and writes each
 * snapshot/update straight into the react-query cache (['stations', cityId, 'backend']),
 * so every component reading station data re-renders without polling.
 * Reconnects with capped exponential backoff.
 */
export function useSensorSocket(cityId: string, enabled: boolean) {
  const qc = useQueryClient();
  const [state, setState] = useState<SocketState>('off');
  const [lastMessageAt, setLastMessageAt] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState('off');
      return;
    }
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      setState('connecting');
      ws = new WebSocket(sensorSocketUrl(cityId));
      ws.onopen = () => {
        retry = 0;
        setState('open');
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as { type: string; city?: string; feed?: StationFeed; result?: AnomalyResult };
        if (msg.city !== cityId) return;
        if ((msg.type === 'snapshot' || msg.type === 'update') && msg.feed) {
          qc.setQueryData(['stations', cityId, 'backend'], msg.feed);
          setLastMessageAt(new Date().toISOString());
        } else if (msg.type === 'anomalies' && msg.result) {
          qc.setQueryData(['anomalies', cityId], msg.result);
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        setState('closed');
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [cityId, enabled, qc]);

  return { state, lastMessageAt };
}
