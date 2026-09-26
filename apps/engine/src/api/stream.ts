/**
 * Server-sent events. Activity is pushed as it is recorded; stats/positions/status snapshots
 * are recomputed every 5s while at least one client is connected and pushed only on change.
 * Connections are capped globally and per client IP; a client that stops reading is dropped.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { StreamEvent } from '@stepup/shared';
import type { Engine } from '../engine.ts';
import { errorMessage, log } from '../log.ts';
import type { Scheduler } from '../scheduler.ts';
import { loadAggregates, statsResponse, statusResponse } from '../views.ts';
import type { AppEnv } from './app.ts';
import { ApiFailure } from './errors.ts';
import { clientIp } from './ratelimit.ts';

const SNAPSHOT_INTERVAL_MS = 5_000;
const HEARTBEAT_MS = 15_000;
export const MAX_STREAMS = 500;
export const MAX_STREAMS_PER_IP = 6;
/** Writes a client may leave unflushed before it is considered stuck and disconnected. */
const MAX_PENDING_WRITES = 64;

export class SnapshotTicker {
  readonly #engine: Engine;
  readonly #scheduler: Scheduler;
  readonly #last = new Map<StreamEvent['type'], string>();
  #timer: NodeJS.Timeout | undefined;
  #clients = 0;

  constructor(engine: Engine, scheduler: Scheduler) {
    this.#engine = engine;
    this.#scheduler = scheduler;
  }

  async snapshot(): Promise<StreamEvent[]> {
    const agg = loadAggregates(this.#engine);
    return [
      { type: 'stats', data: statsResponse(this.#engine, agg) },
      { type: 'positions', data: { positions: agg.positions } },
      { type: 'status', data: await statusResponse(this.#engine, this.#scheduler.health()) },
    ];
  }

  /** Registers a client; `first` is true when it is the only one (its initial snapshot primes change detection). */
  attach(): { first: boolean; detach: () => void } {
    const first = this.#clients++ === 0;
    if (first) this.#timer = setInterval(() => void this.#tick(), SNAPSHOT_INTERVAL_MS);
    const detach = () => {
      if (--this.#clients === 0) {
        clearInterval(this.#timer);
        this.#timer = undefined;
        this.#last.clear();
      }
    };
    return { first, detach };
  }

  /** Primes change detection with a client's initial snapshot, without overwriting anything a tick already sent. */
  remember(events: readonly StreamEvent[]): void {
    for (const ev of events) if (!this.#last.has(ev.type)) this.#last.set(ev.type, JSON.stringify(ev.data));
  }

  async #tick(): Promise<void> {
    try {
      for (const ev of await this.snapshot()) {
        const json = JSON.stringify(ev.data);
        if (this.#last.get(ev.type) === json) continue;
        this.#last.set(ev.type, json);
        this.#engine.bus.emit(ev, json);
      }
    } catch (err) {
      log.warn('stream snapshot failed', { error: errorMessage(err) });
    }
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

export function streamRoutes(app: Hono<AppEnv>, engine: Engine, ticker: SnapshotTicker): void {
  let open = 0;
  const perIp = new Map<string, number>();

  app.get('/api/stream', (c) => {
    const ip = clientIp(c, engine.config.trustProxy);
    if (open >= MAX_STREAMS) throw new ApiFailure(503, 'stream_busy', 'Too many live connections; try again shortly');
    if ((perIp.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) throw new ApiFailure(503, 'stream_busy', 'Too many live connections from this address');
    open++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const release = () => {
      open--;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n > 0) perIp.set(ip, n);
      else perIp.delete(ip);
    };

    return streamSSE(c, async (stream) => {
      let pending = 0;
      // StreamingApi.write never rejects; its promise settles once the client has read the chunk.
      const track = (write: () => Promise<unknown>) => {
        if (stream.aborted || stream.closed) return;
        if (pending >= MAX_PENDING_WRITES) {
          stream.abort();
          return;
        }
        pending++;
        void write().finally(() => pending--);
      };
      const send = (event: string, data: string) => track(() => stream.writeSSE({ event, data }));
      // Events recorded while the initial snapshot is computed are held and written after it, so the
      // client never sees an older snapshot overwrite newer data.
      let held: [string, string][] | null = [];
      const unsubscribe = engine.bus.subscribe((ev, data) => {
        if (!held) send(ev.type, data);
        else if (held.length < MAX_PENDING_WRITES) held.push([ev.type, data]);
        else stream.abort();
      });
      let detach: (() => void) | undefined;
      const heartbeat = setInterval(() => track(() => stream.write(': ping\n\n')), HEARTBEAT_MS);
      try {
        const initial = await ticker.snapshot();
        const attached = ticker.attach();
        detach = attached.detach;
        if (attached.first) ticker.remember(initial);
        for (const ev of initial) send(ev.type, JSON.stringify(ev.data));
        for (const [event, data] of held) send(event, data);
        held = null;
        if (!stream.aborted) await new Promise<void>((resolve) => stream.onAbort(resolve));
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        detach?.();
        release();
      }
    });
  });
}
