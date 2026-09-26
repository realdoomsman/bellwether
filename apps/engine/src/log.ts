/**
 * Minimal structured JSON logger. Values under key-like field names and any registered
 * secret string are redacted wherever they appear.
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

export function setLogLevel(level: Level): void {
  minLevel = LEVELS[level];
}

function scrubString(s: string): string {
  let out = s;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
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
