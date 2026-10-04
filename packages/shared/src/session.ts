/**
 * US equity session classification in America/New_York time (DST-aware via Intl), NYSE holidays and
 * 13:00 early closes included. Hyperliquid's `xyz` stock perps trade 24/7 whatever the session: this is
 * the underlying US market's session (external oracle prices during US hours, order-book pricing
 * otherwise), used for strategy entry gating, signal weighting and UI. Exits never depend on it.
 */
export type MarketSession = 'pre' | 'regular' | 'post' | 'overnight' | 'weekend' | 'holiday';

export const MARKET_SESSIONS: readonly MarketSession[] = ['pre', 'regular', 'post', 'overnight', 'weekend', 'holiday'];

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const DAY_MS = 86_400_000;

/** Day of week (0 = Sunday) of a calendar date. */
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Day of month of the `n`th `weekday` in month `m` (n = -1: the last one). */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  if (n > 0) return 1 + ((weekday - dow(y, m, 1) + 7) % 7) + (n - 1) * 7;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((dow(y, m, last) - weekday + 7) % 7);
}

/** Easter Sunday (anonymous Gregorian algorithm) as epoch ms at UTC midnight. */
function easter(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((8 * b + 13) / 25)) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}

/** A fixed-date holiday's observed date: Saturday → Friday, Sunday → Monday. */
function observed(y: number, m: number, d: number): number {
  const t = Date.UTC(y, m - 1, d);
  const wd = dow(y, m, d);
  return wd === 6 ? t - DAY_MS : wd === 0 ? t + DAY_MS : t;
}

/**
 * NYSE calendar for a New York date: 'closed' on full-day holidays, 'early' on 13:00 early closes.
 * A Saturday New Year's Day is not observed (its Friday falls in the previous year, NYSE Rule 7.2).
 */
export function nyseDay(y: number, m: number, d: number): 'closed' | 'early' | null {
  const t = Date.UTC(y, m - 1, d);
  const thanksgiving = Date.UTC(y, 10, nthWeekday(y, 11, 4, 4));
  const closed = [
    observed(y, 1, 1),
    Date.UTC(y, 0, nthWeekday(y, 1, 1, 3)), // Martin Luther King Jr. Day
    Date.UTC(y, 1, nthWeekday(y, 2, 1, 3)), // Washington's Birthday
    easter(y) - 2 * DAY_MS, // Good Friday
    Date.UTC(y, 4, nthWeekday(y, 5, 1, -1)), // Memorial Day
    observed(y, 6, 19), // Juneteenth
    observed(y, 7, 4),
    Date.UTC(y, 8, nthWeekday(y, 9, 1, 1)), // Labor Day
    thanksgiving,
    observed(y, 12, 25),
  ];
  if (closed.includes(t)) return 'closed';
  // July 3 and Christmas Eve close early Monday to Thursday (on a Friday they are the observed holiday).
  const wd = dow(y, m, d);
  if (((m === 7 && d === 3) || (m === 12 && d === 24)) && wd >= 1 && wd <= 4) return 'early';
  if (t === thanksgiving + DAY_MS) return 'early';
  return null;
}

export function marketSession(at: Date = new Date()): MarketSession {
  const parts = NY.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  const day = nyseDay(Number(get('year')), Number(get('month')), Number(get('day')));
  // Friday 20:00 ET through Sunday 20:00 ET is the weekend gap.
  if (weekday === 'Sat') return 'weekend';
  if (weekday === 'Sun' && minutes < 20 * 60) return 'weekend';
  if (day === 'closed') return 'holiday';
  if (weekday === 'Fri' && minutes >= 20 * 60) return 'weekend';
  const close = day === 'early' ? 13 * 60 : 16 * 60;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre';
  if (minutes >= 9 * 60 + 30 && minutes < close) return 'regular';
  if (minutes >= close && minutes < (day === 'early' ? 17 : 20) * 60) return 'post';
  return 'overnight';
}

export const SESSION_LABEL: Record<MarketSession, string> = {
  pre: 'Pre-market',
  regular: 'Regular hours',
  post: 'After hours',
  overnight: 'Overnight',
  weekend: 'Weekend',
  holiday: 'Holiday',
};
