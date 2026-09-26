const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpError extends Error {
  readonly status: number;
  constructor(what: string, status: number, body: string) {
    super(`${what}: HTTP ${status}${body ? ` ${body}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function describeBody(text: string, contentType: string | null): string {
  if (contentType?.includes('text/html')) {
    return /Just a moment|cf-chl|challenge-platform/i.test(text) ? '(Cloudflare challenge page)' : '(HTML page)';
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * GET (or POST when `body` is given) a JSON endpoint with a hard timeout.
 * Errors name the upstream (`what`) so logs say which dependency failed and how.
 */
export async function fetchJson<T>(what: string, url: string, opts: RequestOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hasBody = opts.body !== undefined;
  let status: number;
  let ok: boolean;
  let contentType: string | null;
  let text: string;
  try {
    const res = await fetch(url, {
      method: hasBody ? 'POST' : 'GET',
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    ok = res.ok;
    contentType = res.headers.get('content-type');
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') throw new Error(`${what}: timed out after ${timeoutMs}ms`);
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}${cause}`);
  }
  if (!ok) throw new HttpError(what, status, describeBody(text, contentType));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what}: expected JSON, got ${describeBody(text, contentType) || 'an empty body'}`);
  }
}

/** Tiny TTL cache that also de-duplicates concurrent loads of the same key. */
export class TtlCache<V> {
  readonly #ttlMs: number;
  readonly #entries = new Map<string, { at: number; value: Promise<V> }>();

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.#entries.get(key);
    if (hit && Date.now() - hit.at < this.#ttlMs) return hit.value;
    return this.refresh(key, load);
  }

  /** Loads now regardless of age and caches the result. */
  refresh(key: string, load: () => Promise<V>): Promise<V> {
    const value = load();
    this.#entries.set(key, { at: Date.now(), value });
    value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
    return value;
  }
}
