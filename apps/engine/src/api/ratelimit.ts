/** Per-key token bucket. Buckets idle long enough to be full are dropped. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #clock: () => number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(capacity: number, refillPerMinute: number, clock: () => number = Date.now) {
    this.#capacity = capacity;
    this.#refillPerMs = refillPerMinute / 60_000;
    this.#clock = clock;
  }

  /** Consumes one token for `key`; false when the bucket is empty. */
  take(key: string): boolean {
    const now = this.#clock();
    if (this.#buckets.size > 10_000) this.#sweep(now);
    const b = this.#buckets.get(key) ?? { tokens: this.#capacity, at: now };
    b.tokens = Math.min(this.#capacity, b.tokens + (now - b.at) * this.#refillPerMs);
    b.at = now;
    this.#buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  #sweep(now: number): void {
    for (const [key, b] of this.#buckets) {
      if (b.tokens + (now - b.at) * this.#refillPerMs >= this.#capacity) this.#buckets.delete(key);
    }
  }
}
