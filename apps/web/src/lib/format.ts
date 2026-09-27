/** Every number the UI prints goes through here, so rounding and signs stay consistent. */

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const ET_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_HMS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const ET_FULL = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const DASH = '—';

/** Sign for a formatted magnitude `body`: none when it prints as zero, so a rounded-away loss never reads as one. */
function sign(n: number, signed: boolean, body: string): string {
  if (!/[1-9]/.test(body)) return '';
  if (n < 0) return '−';
  return signed && n > 0 ? '+' : '';
}

export function usd(n: number | null | undefined, opts: { signed?: boolean; compact?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  const body = opts.compact && abs >= 10_000 ? USD_COMPACT.format(abs) : USD.format(abs);
  return sign(n, opts.signed ?? false, body) + body;
}

/** Asset prices: cents above $1, four significant digits below (memecoins, fractional shares), never an exponent. */
export function price(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  if (Math.abs(n) >= 1) return USD.format(n);
  if (n === 0) return '$0.00';
  // toPrecision switches to e-notation below 1e-6; count the leading zeros instead ($0.0000005 -> $0.0000005000).
  return `$${n.toFixed(Math.min(20, 3 - Math.floor(Math.log10(Math.abs(n)))))}`;
}

export function eth(n: number | null | undefined, opts: { signed?: boolean; unit?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  const unit = opts.unit === false ? '' : ' ETH';
  if (abs === 0) return `0${unit}`;
  if (abs < 0.0001) return `${sign(n, opts.signed ?? false, '<0.0001')}<0.0001${unit}`;
  // Below 0.01 ETH, fixed decimals would leave one or two significant digits (fees, buybacks): keep three.
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 4;
  const body =
    abs < 0.01
      ? abs.toLocaleString('en-US', { maximumSignificantDigits: 3 })
      : abs.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) });
  return `${sign(n, opts.signed ?? false, body)}${body}${unit}`;
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return Math.abs(n) < 10_000 ? INT.format(n) : COMPACT.format(n);
}

export function int(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return INT.format(n);
}

/** `frac` is a fraction (0.12 = 12%). */
export function pct(frac: number | null | undefined, opts: { signed?: boolean; digits?: number } = {}): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return DASH;
  const v = Math.abs(frac * 100);
  const digits = opts.digits ?? (v !== 0 && v < 1 ? 2 : 1);
  const body = v.toFixed(digits);
  return `${sign(frac, opts.signed ?? false, body)}${body}%`;
}

/** Whole percent, for protocol constants (60%, 25%, 15%) and stops. */
export function pct0(frac: number): string {
  return pct(frac, { digits: 0 });
}

export function leverage(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}×`;
}

export function relTime(at: number | null | undefined, now = Date.now()): string {
  if (!at) return DASH;
  const s = Math.round((now - at) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 60) return `in ${f}s`;
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    return `in ${Math.round(f / 3600)}h`;
  }
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return DATE.format(at);
}

export function dateTime(at: number): string {
  return DATE_TIME.format(at);
}

/** Wall-clock time in New York, always labelled: "14:03 ET" (or "14:03:12 ET" with seconds). */
export function etTime(at: number, opts: { seconds?: boolean } = {}): string {
  return `${(opts.seconds ? ET_HMS : ET_HM).format(at)} ET`;
}

/** Absolute ET timestamp for tooltips and receipts: "Sep 27, 14:03 ET". */
export function etDateTime(at: number): string {
  return `${ET_FULL.format(at)} ET`;
}

export function shortAddr(a: string | null | undefined, lead = 6, tail = 4): string {
  if (!a) return DASH;
  return a.length <= lead + tail + 1 ? a : `${a.slice(0, lead)}…${a.slice(-tail)}`;
}

/** Up/down class for a value formatted with `signed: true`: follows the printed sign, so a value that rounds to zero is neutral. */
export function tone(formatted: string): 'up' | 'down' | '' {
  return formatted.startsWith('+') ? 'up' : formatted.startsWith('−') ? 'down' : '';
}
