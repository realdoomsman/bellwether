/**
 * Small TTL cache with in-flight de-duplication. Failed loads are not cached. Holds at most
 * `maxEntries` values; the least recently stored one is evicted first.
 */
export class TtlCache<V> {
  readonly #ttlMs: number;
  readonly #clock: () => number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, { value: V; at: number }>();
  readonly #inflight = new Map<string, Promise<V>>();

  constructor(ttlMs: number, clock: () => number = Date.now, maxEntries = 5_000) {
    this.#ttlMs = ttlMs;
    this.#clock = clock;
    this.#maxEntries = maxEntries;
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.#entries.get(key);
    if (hit && this.#clock() - hit.at < this.#ttlMs) return hit.value;
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((value) => {
        this.#entries.delete(key);
        this.#entries.set(key, { value, at: this.#clock() });
        if (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
        return value;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  /** Last loaded value regardless of age. */
  peek(key: string): V | undefined {
    return this.#entries.get(key)?.value;
  }

  isFresh(key: string): boolean {
    const hit = this.#entries.get(key);
    return hit !== undefined && this.#clock() - hit.at < this.#ttlMs;
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

/** Runs keyed background tasks one at a time, ignoring keys already queued. */
export class SerialQueue {
  readonly #queue = new Map<string, () => Promise<unknown>>();
  #draining = false;

  enqueue(key: string, task: () => Promise<unknown>): void {
    if (this.#queue.has(key)) return;
    this.#queue.set(key, task);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (const [key, task] of this.#queue) {
        await task().catch(() => undefined);
        this.#queue.delete(key);
      }
    } finally {
      this.#draining = false;
    }
  }
}
