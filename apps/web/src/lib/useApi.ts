import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { ApiRequestError } from './api';

/**
 * Tiny keyed query cache shared by every component: one request per key in flight,
 * last-known data kept on refresh failure (`stale`), and SSE pushes via `setApiData`.
 */
export interface ApiState<T> {
  data: T | undefined;
  error: ApiRequestError | undefined;
  /** First load in flight, nothing to show yet. */
  loading: boolean;
  /** Showing last-known data because the latest refresh failed. */
  stale: boolean;
  updatedAt: number | null;
}

type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

interface Entry {
  state: ApiState<unknown>;
  listeners: Set<() => void>;
  fetcher: Fetcher<unknown> | null;
  inflight: AbortController | null;
}

const PENDING: ApiState<never> = { data: undefined, error: undefined, loading: true, stale: false, updatedAt: null };
const DISABLED: ApiState<never> = { ...PENDING, loading: false };
const entries = new Map<string, Entry>();

function entryFor(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { state: PENDING, listeners: new Set(), fetcher: null, inflight: null };
    entries.set(key, e);
  }
  return e;
}

function patch(e: Entry, next: Pick<ApiState<unknown>, 'data' | 'error' | 'updatedAt'>): void {
  e.state = {
    ...next,
    loading: next.data === undefined && next.error === undefined,
    stale: next.data !== undefined && next.error !== undefined,
  };
  for (const l of e.listeners) l();
}

async function load(key: string): Promise<void> {
  const e = entries.get(key);
  if (!e?.fetcher || e.inflight) return;
  const ctrl = new AbortController();
  e.inflight = ctrl;
  try {
    const data = await e.fetcher(ctrl.signal);
    patch(e, { data, error: undefined, updatedAt: Date.now() });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    const error =
      err instanceof ApiRequestError ? err : new ApiRequestError(0, 'client_error', err instanceof Error ? err.message : String(err));
    patch(e, { data: e.state.data, error, updatedAt: e.state.updatedAt });
  } finally {
    if (e.inflight === ctrl) e.inflight = null;
  }
}

/** Replace cached data (e.g. from the SSE stream). Returning undefined leaves the entry untouched. */
export function setApiData<T>(key: string, update: (prev: T | undefined) => T | undefined): void {
  const e = entryFor(key);
  const data = update(e.state.data as T | undefined);
  if (data !== undefined) patch(e, { data, error: undefined, updatedAt: Date.now() });
}

/** Refetch a key if anything on screen is using it. */
export function revalidate(key: string): void {
  const e = entries.get(key);
  if (e && e.listeners.size > 0) void load(key);
}

export interface UseApiOptions {
  /** Poll interval while mounted and the tab is visible. */
  refreshMs?: number;
  /** Cached data younger than this is used without refetching on mount. */
  maxAgeMs?: number;
}

export function useApi<T>(
  key: string | null,
  fetcher: Fetcher<T>,
  { refreshMs, maxAgeMs = 5_000 }: UseApiOptions = {},
): ApiState<T> & { refresh: () => void } {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {};
      const e = entryFor(key);
      e.listeners.add(listener);
      return () => {
        e.listeners.delete(listener);
        if (e.listeners.size === 0 && e.inflight) {
          e.inflight.abort();
          e.inflight = null;
        }
      };
    },
    [key],
  );
  const state = useSyncExternalStore(subscribe, () => (key ? (entries.get(key)?.state ?? PENDING) : DISABLED)) as ApiState<T>;

  useEffect(() => {
    if (!key) return;
    const e = entryFor(key);
    e.fetcher = (signal) => fetcherRef.current(signal);
    const age = e.state.updatedAt === null ? Infinity : Date.now() - e.state.updatedAt;
    if (age > maxAgeMs || e.state.error) void load(key);
    if (!refreshMs) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void load(key);
    };
    const timer = setInterval(tick, refreshMs);
    const onVisible = () => {
      const stale = e.state.updatedAt === null || Date.now() - e.state.updatedAt > refreshMs;
      if (document.visibilityState === 'visible' && stale) void load(key);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, refreshMs, maxAgeMs]);

  const refresh = useCallback(() => {
    if (key) void load(key);
  }, [key]);

  return { ...state, refresh };
}
