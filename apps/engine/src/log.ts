/**
 * Minimal structured JSON logger. Values under key-like field names, any registered secret string,
 * and URLs that look like they carry credentials are redacted wherever they appear.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(private|secret|password|passwd|mnemonic|seed[-_]?phrase|api[-_]?key|admin[-_]?token|authorization|bearer|signature|cookie)/i;
const REDACTED = '[redacted]';

const secrets = new Set<string>();
let minLevel = LEVELS.info;

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

/** Registers a private endpoint URL: the whole URL plus its path and query, which often embed an API key. */
export function registerSecretUrl(value: string | null | undefined): void {
  if (!value) return;
  registerSecret(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const path = url.pathname.replace(/\/+$/, '');
  const keySegments = path.split('/').filter((s) => KEYLIKE.test(s));
  if (keySegments.length) registerSecret(path);
  for (const segment of keySegments) registerSecret(segment);
  if (url.search.length > 1) registerSecret(url.search.slice(1));
  if (url.username) registerSecret(url.username);
  if (url.password) registerSecret(url.password);
}

export function setLogLevel(level: Level): void {
  minLevel = LEVELS[level];
}

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;
/** Path segments / query values that look like API keys: long runs of key-ish characters. */
const KEYLIKE = /[A-Za-z0-9_-]{20,}/;
const KEY_PARAM = /(key|token|secret|auth|pass|sig|credential)/i;

/** Keeps scheme + host of URLs that carry userinfo or key-like path/query parts; the rest is redacted. */
function scrubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const params = [...url.searchParams.entries()];
  const suspicious =
    url.username !== '' ||
    url.password !== '' ||
    url.pathname.split('/').some((s) => KEYLIKE.test(s)) ||
    params.some(([k, v]) => KEY_PARAM.test(k) || KEYLIKE.test(v));
  return suspicious ? `${url.protocol}//${url.host}/${REDACTED}` : raw;
}

export function scrubString(s: string): string {
  let out = s;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out.replace(URL_PATTERN, scrubUrl).replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
}

const PUBLIC_ERROR_MAX = 300;

/**
 * Error text that is safe to store and publish (status API, SSE, alerts): the first line only (viem
 * appends `URL:` / `Request body:` meta lines), scrubbed of secrets and credential URLs, bounded.
 */
export function publicErrorText(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  const clean = scrubString(line);
  return clean.length > PUBLIC_ERROR_MAX ? `${clean.slice(0, PUBLIC_ERROR_MAX - 1)}…` : clean;
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? REDACTED : scrub(v, depth + 1);
  return out;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: scrubString(msg), ...(scrub(fields ?? {}) as object) });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
