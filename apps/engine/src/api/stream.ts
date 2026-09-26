/**
 * Server-sent events. Activity is pushed as it is recorded; stats/positions/status snapshots
 * are recomputed every 5s while at least one client is connected and pushed only on change.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { StreamEvent } from '@floor/shared';
import type { Engine } from '../engine.ts';
import { errorMessage, log } from '../log.ts';
import type { Scheduler } from '../scheduler.ts';
import { loadAggregates, statsResponse, statusResponse } from '../views.ts';
import type { AppEnv } from './app.ts';

const SNAPSHOT_INTERVAL_MS = 5_000;
const HEARTBEAT_MS = 15_000;

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

  remember(events: readonly StreamEvent[]): void {
    for (const ev of events) this.#last.set(ev.type, JSON.stringify(ev.data));
  }

  async #tick(): Promise<void> {
    try {
      for (const ev of await this.snapshot()) {
        const json = JSON.stringify(ev.data);
        if (this.#last.get(ev.type) === json) continue;
        this.#last.set(ev.type, json);
        this.#engine.bus.emit(ev);
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
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const send = (ev: StreamEvent) => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev.data) });
      const unsubscribe = engine.bus.subscribe((ev) => void send(ev));
      const { first, detach } = ticker.attach();
      const heartbeat = setInterval(() => void stream.write(': ping\n\n'), HEARTBEAT_MS);
      try {
        const initial = await ticker.snapshot();
        if (first) ticker.remember(initial);
        for (const ev of initial) await send(ev);
        if (!stream.aborted) await new Promise<void>((resolve) => stream.onAbort(resolve));
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        detach();
      }
    }),
  );
}
