/**
 * US equity session classification in America/New_York time (DST-aware via Intl).
 * Exchange holidays are not modelled; the venue's own "market open" flag is authoritative
 * for execution, this is for strategy gating and UI.
 */
export type MarketSession = 'pre' | 'regular' | 'post' | 'overnight' | 'weekend';

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function marketSession(at: Date = new Date()): MarketSession {
  const parts = NY.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  // Friday 20:00 ET through Sunday 20:00 ET is the weekend gap.
  if (weekday === 'Sat') return 'weekend';
  if (weekday === 'Sun' && minutes < 20 * 60) return 'weekend';
  if (weekday === 'Fri' && minutes >= 20 * 60) return 'weekend';
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre';
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'regular';
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'post';
  return 'overnight';
}

export const SESSION_LABEL: Record<MarketSession, string> = {
  pre: 'Pre-market',
  regular: 'Market open',
  post: 'After hours',
  overnight: 'Overnight',
  weekend: 'Weekend',
};
