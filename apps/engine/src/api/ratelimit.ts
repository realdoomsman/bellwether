import type { Context } from 'hono';
import type { AppEnv } from './app.ts';

/**
 * Per-key token bucket. The map is bounded: it is kept in least-recently-used order and the oldest
 * bucket is dropped once `maxKeys` is exceeded, so every `take` stays O(1) whatever the key churn.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #clock: () => number;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(capacity: number, refillPerMinute: number, clock: () => number = Date.now, maxKeys = 10_000) {
    this.#capacity = capacity;
    this.#refillPerMs = refillPerMinute / 60_000;
    this.#clock = clock;
    this.#maxKeys = maxKeys;
  }

  /** Consumes one token for `key`; false when the bucket is empty. */
  take(key: string): boolean {
    const now = this.#clock();
    const b = this.#buckets.get(key) ?? { tokens: this.#capacity, at: now };
    b.tokens = Math.min(this.#capacity, b.tokens + (now - b.at) * this.#refillPerMs);
    b.at = now;
    // Re-insert so iteration order is least recently used first.
    this.#buckets.delete(key);
    this.#buckets.set(key, b);
    if (this.#buckets.size > this.#maxKeys) this.#buckets.delete(this.#buckets.keys().next().value!);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/**
 * The client address used for rate limits and connection caps. Behind the (single) trusted proxy the
 * RIGHTMOST X-Forwarded-For entry is the one the proxy appended; everything left of it is client-supplied.
 */
export function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  const forwarded = trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded || c.env?.incoming?.socket?.remoteAddress || 'unknown';
}
