import type { ActivityKind, ActivityResponse, PositionsResponse, StreamEvent } from '@stepup/shared';
import { useSyncExternalStore } from 'react';
import { API_BASE } from './api';
import { revalidate, setApiData } from './useApi';

/**
 * One EventSource for the whole app. Pushes stats/positions/status/activity into the query
 * cache; while it is down, stream-backed queries fall back to 15s polling (see useStreamRefresh).
 */
export type StreamState = 'connecting' | 'live' | 'reconnecting';

const EVENT_TYPES = ['activity', 'stats', 'positions', 'status'] as const satisfies readonly StreamEvent['type'][];
const MAX_BACKOFF_MS = 30_000;
const ACTIVITY_KEEP = 200;

/** Query key for the pooled trades list; refetched when the stream shows a trade happened. */
export const TRADES_KEY = 'trades';
const TRADE_KINDS: Partial<Record<ActivityKind, true>> = { open: true, reduce: true, close: true, stop: true, liquidated: true };

/** Changes only when a trade opens, resizes or closes a position; mark-price ticks leave it alone. */
function positionsShape(p: PositionsResponse): string {
  return p.positions.map((x) => `${x.id}:${x.sizeUsd}`).join('|');
}

let state: StreamState = 'connecting';
const listeners = new Set<() => void>();
const pendingRevalidations = new Set<string>();

function setState(next: StreamState): void {
  if (state === next) return;
  state = next;
  for (const l of listeners) l();
}

/** Coalesce refetches triggered by bursts of activity events. */
function revalidateSoon(key: string): void {
  if (pendingRevalidations.has(key)) return;
  pendingRevalidations.add(key);
  setTimeout(() => {
    pendingRevalidations.delete(key);
    revalidate(key);
  }, 1_500);
}

function apply(ev: StreamEvent): void {
  switch (ev.type) {
    case 'stats':
      setApiData('stats', () => ev.data);
      break;
    case 'positions': {
      let traded = false;
      setApiData<PositionsResponse>('positions', (prev) => {
        traded = prev !== undefined && positionsShape(prev) !== positionsShape(ev.data);
        return ev.data;
      });
      if (traded) revalidateSoon(TRADES_KEY);
      break;
    }
    case 'status':
      setApiData('status', () => ev.data);
      break;
    case 'activity': {
      const event = ev.data;
      setApiData<ActivityResponse>('activity', (prev) =>
        prev && !prev.events.some((e) => e.id === event.id)
          ? { ...prev, events: [event, ...prev.events].slice(0, ACTIVITY_KEEP) }
          : undefined,
      );
      revalidateSoon('tokens');
      if (event.token) revalidateSoon(`token:${event.token.toLowerCase()}`);
      if (TRADE_KINDS[event.kind]) revalidateSoon(TRADES_KEY);
      break;
    }
  }
}

export function connectStream(): () => void {
  if (typeof EventSource === 'undefined') {
    setState('reconnecting');
    return () => {};
  }
  let source: EventSource | null = null;
  let timer: number | undefined;
  let attempt = 0;
  let closed = false;

  const open = () => {
    source = new EventSource(`${API_BASE}/stream`);
    source.onopen = () => {
      // After an outage, catch up on whatever the stream missed.
      if (attempt > 0) for (const key of ['activity', 'tokens', 'stats', 'positions', 'status']) revalidate(key);
      attempt = 0;
      setState('live');
    };
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      setState('reconnecting');
      const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt += 1;
      timer = window.setTimeout(open, delay);
    };
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (msg) => {
        try {
          apply({ type, data: JSON.parse((msg as MessageEvent<string>).data) } as StreamEvent);
        } catch {
          // A malformed frame is dropped; polling/revalidation keeps the cache honest.
        }
      });
    }
  };

  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStreamState(): StreamState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Refresh interval for stream-backed data: a slow safety poll while live, 15s polling otherwise. */
export function useStreamRefresh(): number {
  return useStreamState() === 'live' ? 60_000 : 15_000;
}
