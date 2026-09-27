/**
 * Worker scheduler: interval + jitter, capped exponential backoff on failure, no overlapping
 * runs of the same worker, manual triggers, and one global execution lock shared by every
 * worker that writes to a chain or venue (so a single signer never races itself).
 */
import type { WorkerHealth, WorkerId } from '@bellwether/shared';
import type { Db } from './db.ts';
import { shortError } from './integrations/errors.ts';
import { errorMessage, log, publicErrorText } from './log.ts';

export interface WorkerDef {
  id: WorkerId;
  label: string;
  intervalMs: number;
  /** Longest failure backoff as a multiple of `intervalMs` (default 8); risk loops keep it small. */
  maxBackoffFactor?: number;
  /** Performs chain/venue writes: runs under the global execution lock. */
  exclusive: boolean;
  /** Returns a one-line summary of what happened. */
  run(): Promise<string>;
}

export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export class WorkerBusyError extends Error {}

interface State {
  def: WorkerDef;
  health: WorkerHealth;
  timer: NodeJS.Timeout | undefined;
  current: Promise<void> | null;
}

const JITTER = 0.1;
const RUNS_KEPT_PER_WORKER = 500;

export function backoffDelay(intervalMs: number, consecutiveErrors: number, maxFactor = 8): number {
  const cap = Math.min(intervalMs * maxFactor, Math.max(intervalMs, 30 * 60_000));
  return Math.min(intervalMs * 2 ** consecutiveErrors, cap);
}

/** Called after every run with the updated health and the failure streak before this run. */
export type RunObserver = (health: WorkerHealth, ok: boolean, previousErrors: number) => void;

export class Scheduler {
  readonly executionLock = new Mutex();
  readonly #db: Db;
  readonly #clock: () => number;
  readonly #observer: RunObserver | undefined;
  readonly #states = new Map<WorkerId, State>();
  #stopped = true;

  constructor(db: Db, defs: readonly WorkerDef[], clock: () => number = Date.now, observer?: RunObserver) {
    this.#db = db;
    this.#clock = clock;
    this.#observer = observer;
    for (const def of defs) {
      const last = db.get<{ finished_at: number; ok: number; error: string | null }>(
        'SELECT finished_at, ok, error FROM worker_runs WHERE worker = ? ORDER BY id DESC LIMIT 1',
        [def.id],
      );
      const lastOk = db.get<{ finished_at: number }>(
        'SELECT finished_at FROM worker_runs WHERE worker = ? AND ok = 1 ORDER BY id DESC LIMIT 1',
        [def.id],
      );
      this.#states.set(def.id, {
        def,
        timer: undefined,
        current: null,
        health: {
          id: def.id,
          label: def.label,
          lastRunAt: last?.finished_at ?? null,
          lastOkAt: lastOk?.finished_at ?? null,
          lastError: last && last.ok === 0 ? last.error : null,
          consecutiveErrors: 0,
          nextRunAt: null,
          running: false,
        },
      });
    }
  }

  start(): void {
    this.#stopped = false;
    let i = 0;
    for (const s of this.#states.values()) this.#schedule(s, 2_000 + 1_500 * i++);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const s of this.#states.values()) {
      clearTimeout(s.timer);
      s.timer = undefined;
      s.health.nextRunAt = null;
    }
    await Promise.all([...this.#states.values()].map((s) => s.current));
  }

  health(): WorkerHealth[] {
    return [...this.#states.values()].map((s) => ({ ...s.health }));
  }

  has(id: string): id is WorkerId {
    return this.#states.has(id as WorkerId);
  }

  /** Runs a worker now. Rejects with WorkerBusyError when it is already running. */
  async runNow(id: WorkerId): Promise<{ ok: boolean; summary: string }> {
    const s = this.#states.get(id);
    if (!s) throw new Error(`unknown worker ${id}`);
    if (s.current) throw new WorkerBusyError(`${id} is already running`);
    clearTimeout(s.timer);
    s.timer = undefined;
    return this.#execute(s);
  }

  #schedule(s: State, delayMs: number): void {
    if (this.#stopped) return;
    clearTimeout(s.timer);
    s.health.nextRunAt = this.#clock() + delayMs;
    s.timer = setTimeout(() => {
      s.timer = undefined;
      if (!s.current) void this.#execute(s);
    }, delayMs);
  }

  async #execute(s: State): Promise<{ ok: boolean; summary: string }> {
    const startedAt = this.#clock();
    const previousErrors = s.health.consecutiveErrors;
    s.health.running = true;
    s.health.nextRunAt = null;
    let outcome: { ok: boolean; summary: string } = { ok: false, summary: '' };
    let done!: () => void;
    s.current = new Promise<void>((resolve) => (done = resolve));
    try {
      const summary = await (s.def.exclusive ? this.executionLock.run(() => s.def.run()) : s.def.run());
      outcome = { ok: true, summary };
      s.health.lastOkAt = this.#clock();
      s.health.lastError = null;
      s.health.consecutiveErrors = 0;
      log.info('worker ok', { worker: s.def.id, ms: this.#clock() - startedAt, summary });
    } catch (err) {
      // Stored and published (status API, SSE, alerts): viem messages carry the RPC URL in meta lines.
      const message = publicErrorText(shortError(err));
      outcome = { ok: false, summary: message };
      s.health.lastError = message;
      s.health.consecutiveErrors++;
      log.error('worker failed', { worker: s.def.id, error: errorMessage(err), consecutiveErrors: s.health.consecutiveErrors });
    } finally {
      const finishedAt = this.#clock();
      s.health.running = false;
      s.health.lastRunAt = finishedAt;
      this.#persist(s.def.id, startedAt, finishedAt, outcome);
      try {
        this.#observer?.({ ...s.health }, outcome.ok, previousErrors);
      } catch (err) {
        log.warn('run observer failed', { worker: s.def.id, error: errorMessage(err) });
      }
      s.current = null;
      done();
      const base = s.health.consecutiveErrors > 0 ? backoffDelay(s.def.intervalMs, s.health.consecutiveErrors, s.def.maxBackoffFactor) : s.def.intervalMs;
      this.#schedule(s, Math.round(base * (1 - JITTER + Math.random() * 2 * JITTER)));
    }
    return outcome;
  }

  #persist(worker: WorkerId, startedAt: number, finishedAt: number, o: { ok: boolean; summary: string }): void {
    try {
      this.#db.run('INSERT INTO worker_runs (worker, started_at, finished_at, ok, error, summary) VALUES (?, ?, ?, ?, ?, ?)', [
        worker,
        startedAt,
        finishedAt,
        o.ok ? 1 : 0,
        o.ok ? null : o.summary,
        o.ok ? o.summary : null,
      ]);
      this.#db.run(
        `DELETE FROM worker_runs WHERE worker = ? AND id <= (
           SELECT id FROM worker_runs WHERE worker = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        [worker, worker, RUNS_KEPT_PER_WORKER],
      );
    } catch (err) {
      log.error('failed to persist worker run', { worker, error: errorMessage(err) });
    }
  }
}
