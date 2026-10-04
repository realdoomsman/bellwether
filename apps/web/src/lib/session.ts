import { marketSession, SESSION_LABEL, type MarketSession } from '@bellwether/shared';
import { useNow } from './hooks';
import { useStatus } from './queries';

/**
 * The US stock market session as the header shows it: the engine's reported session (it gates the
 * strategies' new entries) with the client clock as the fallback, plus when NYSE next opens or closes.
 * The perps themselves trade 24/7; this is only the underlying market's clock.
 */
export interface SessionClock {
  session: MarketSession;
  label: string;
  /** "NYSE closes in 2h 14m", "NYSE opens Mon 09:30 ET". */
  detail: string;
  /** open = regular hours; extended = pre/post; off = US market shut (perps still trade). */
  tone: 'open' | 'extended' | 'off';
}

const ET_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
/** Every session boundary (04:00, 09:30, 13:00, 16:00, 17:00, 20:00 ET) sits on a UTC half hour. */
const STEP_MS = 30 * 60_000;
/** Longest stretch without a regular session: a Thursday holiday into a Monday holiday, with margin. */
const MAX_STEPS = 6 * 48;

/** Epoch ms of the first session boundary after `now` whose session satisfies `ok` (holiday- and DST-aware). */
function nextBoundary(now: number, ok: (s: MarketSession) => boolean): number {
  let at = Math.floor(now / STEP_MS) * STEP_MS + STEP_MS;
  for (let i = 0; i < MAX_STEPS && !ok(marketSession(new Date(at))); i++) at += STEP_MS;
  return at;
}

function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function sessionClock(now: number, reported?: MarketSession): SessionClock {
  const session = reported ?? marketSession(new Date(now));
  const label = SESSION_LABEL[session];
  if (session === 'regular') {
    return { session, label, tone: 'open', detail: `NYSE closes in ${span(nextBoundary(now, (s) => s !== 'regular') - now)}` };
  }
  const open = nextBoundary(now, (s) => s === 'regular');
  const until = open - now;
  const detail = until < 12 * 3_600_000 ? `NYSE opens in ${span(until)}` : `NYSE opens ${ET_WEEKDAY.format(open)} 09:30 ET`;
  return { session, label, detail, tone: session === 'pre' || session === 'post' ? 'extended' : 'off' };
}

/** Session for the UI; re-evaluated every 30 s so the countdown stays on time between engine pushes. */
export function useSessionClock(): SessionClock {
  const now = useNow(30_000);
  const status = useStatus();
  // The engine's word wins while it's current (streamed every 5 s); the client clock covers offline.
  return sessionClock(now, status.data && !status.stale ? status.data.session : undefined);
}
