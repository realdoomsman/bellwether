import { marketSession, SESSION_LABEL, type MarketSession } from '@bellwether/shared';
import { useNow } from './hooks';
import { useStatus } from './queries';

/**
 * The US market session as the header shows it: the engine's reported session (it gates the strategies)
 * with the client clock as the fallback, plus when the next open or close happens.
 * Exchange holidays are not modelled, exactly like the engine.
 */
export interface SessionClock {
  session: MarketSession;
  label: string;
  /** "closes in 2h 14m", "opens Mon 09:30 ET". */
  detail: string;
  /** open = regular hours; extended = pre/post; closed = overnight/weekend. */
  tone: 'open' | 'extended' | 'closed';
}

const ET_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

function etParts(at: number): { day: number; min: number } {
  const parts = ET_PARTS.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: WEEKDAYS.indexOf(get('weekday')), min: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Epoch ms of the next ET wall-clock `targetMin` on a day accepted by `dayOk`, corrected across DST changes. */
function nextAt(now: number, targetMin: number, dayOk: (day: number) => boolean): number {
  const { day, min } = etParts(now);
  let ahead = 0;
  while (ahead < 8 && (!dayOk((day + ahead) % 7) || (ahead === 0 && min >= targetMin))) ahead += 1;
  let at = now + ((ahead * 1440 + targetMin - min) * 60 - (Math.floor(now / 1000) % 60)) * 1000;
  // A DST switch in between moves the wall clock by an hour; nudge back onto the target minute.
  const drift = targetMin - etParts(at).min;
  if (drift !== 0 && Math.abs(drift) <= 60) at += drift * 60_000;
  return at;
}

function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const isWeekday = (d: number) => d >= 1 && d <= 5;

export function sessionClock(now: number, reported?: MarketSession): SessionClock {
  const session = reported ?? marketSession(new Date(now));
  const label = SESSION_LABEL[session];
  if (session === 'regular') {
    return { session, label, tone: 'open', detail: `closes in ${span(nextAt(now, CLOSE_MIN, isWeekday) - now)}` };
  }
  const open = nextAt(now, OPEN_MIN, isWeekday);
  const until = open - now;
  const detail = until < 12 * 3_600_000 ? `opens in ${span(until)}` : `opens ${WEEKDAYS[etParts(open).day]} 09:30 ET`;
  return { session, label, detail, tone: session === 'pre' || session === 'post' ? 'extended' : 'closed' };
}

/** Session for the UI; re-evaluated every 30 s so the countdown stays on time between engine pushes. */
export function useSessionClock(): SessionClock {
  const now = useNow(30_000);
  const status = useStatus();
  // The engine's word wins while it's current (streamed every 5 s); the client clock covers offline.
  return sessionClock(now, status.data && !status.stale ? status.data.session : undefined);
}
