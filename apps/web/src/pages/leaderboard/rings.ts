import type { ActivityEvent } from '@bellwether/shared';
import { useEffect } from 'react';
import { api } from '../../lib/api';
import { onActivity } from '../../lib/stream';
import { setApiData, useApi } from '../../lib/useApi';

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const PAGE = 200;
const MAX_PAGES = 5;
export const RINGS_KEY = 'leaderboard:rings';

/** Buyback history per token, rebuilt from the public activity log. Keys are lower-case addresses. */
export interface RingIndex {
  /** Newest buyback per token. */
  last: Record<string, number>;
  /** Tokens burned per UTC day for the last 30 days, oldest first; only when `coversWindow`. */
  daily: Record<string, number[]>;
  /** Oldest event scanned; buybacks before it aren't in `last`. */
  scannedFrom: number | null;
  /** True when the scan reached the start of the log or went back past the 30-day window. */
  coversWindow: boolean;
  /** True when the scan reached the start of the log, so a token missing from `last` never burned. */
  complete: boolean;
}

function addRing(index: RingIndex, e: ActivityEvent): void {
  if (e.kind !== 'buyback' || !e.token) return;
  const key = e.token.toLowerCase();
  index.last[key] = Math.max(index.last[key] ?? 0, e.at);
  // Day slot in the window: 0 is 29 days ago, WINDOW_DAYS - 1 is today (UTC).
  const i = WINDOW_DAYS - 1 - (Math.floor(Date.now() / DAY) - Math.floor(e.at / DAY));
  if (i < 0 || i >= WINDOW_DAYS) return;
  const days = (index.daily[key] ??= new Array<number>(WINDOW_DAYS).fill(0));
  days[i] = (days[i] ?? 0) + (e.tokensBurned ?? 0);
}

/** Pages back through /api/activity until 30 days are covered, the log ends, or the page budget runs out. */
async function scan(signal: AbortSignal): Promise<RingIndex> {
  const index: RingIndex = { last: {}, daily: {}, scannedFrom: null, coversWindow: false, complete: false };
  const horizon = Date.now() - WINDOW_DAYS * DAY;
  let before: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.activity({ limit: PAGE, ...(before !== undefined ? { before } : {}) }, signal);
    for (const e of res.events) addRing(index, e);
    const oldest = res.events[res.events.length - 1];
    if (oldest) index.scannedFrom = oldest.at;
    if (res.nextBefore === null) {
      index.complete = true;
      index.coversWindow = true;
      break;
    }
    if (oldest && oldest.at < horizon) {
      index.coversWindow = true;
      break;
    }
    before = res.nextBefore;
  }
  return index;
}

/** Last ring and 30-day burn history per token; live buybacks from the stream update it in place. */
export function useRings() {
  const q = useApi(RINGS_KEY, scan, { refreshMs: 120_000, maxAgeMs: 30_000 });
  useEffect(
    () =>
      onActivity((e) => {
        if (e.kind !== 'buyback' || !e.token) return;
        setApiData<RingIndex>(RINGS_KEY, (prev) => {
          if (!prev) return prev;
          const next: RingIndex = { ...prev, last: { ...prev.last }, daily: Object.fromEntries(Object.entries(prev.daily).map(([k, v]) => [k, [...v]])) };
          addRing(next, e);
          return next;
        }, { partial: true });
      }),
    [],
  );
  return q;
}
