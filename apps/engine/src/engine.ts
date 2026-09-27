/** The engine context shared by workers and the API. */
import { randomUUID } from 'node:crypto';
import type { ActivityEvent } from '@bellwether/shared';
import pkg from '../package.json' with { type: 'json' };
import { recordActivity, type NewActivity } from './activity.ts';
import { EventBus } from './bus.ts';
import type { EngineConfig } from './config.ts';
import { kvGet, kvSet, type Db } from './db.ts';
import { Ledger } from './ledger.ts';
import { MarketData } from './market.ts';
import type { Integrations } from './ports.ts';

export const VERSION: string = pkg.version;

export interface Engine {
  config: EngineConfig;
  db: Db;
  ledger: Ledger;
  io: Integrations;
  bus: EventBus;
  market: MarketData;
  clock: () => number;
  startedAt: number;
}

export function createEngine(p: { config: EngineConfig; db: Db; io: Integrations; clock?: () => number }): Engine {
  const clock = p.clock ?? Date.now;
  return {
    config: p.config,
    db: p.db,
    ledger: new Ledger(p.db),
    io: p.io,
    bus: new EventBus(),
    market: new MarketData(p.io, clock),
    clock,
    startedAt: clock(),
  };
}

export function newId(): string {
  return randomUUID();
}

export function activity(engine: Engine, a: Omit<NewActivity, 'at'>): ActivityEvent {
  return recordActivity(engine.db, engine.bus, { ...a, at: engine.clock() });
}

// ─── Kill switch ─────────────────────────────────────────────────────────────
const KILL_SWITCH_KEY = 'kill_switch';

export function killSwitchOn(engine: Engine): boolean {
  return kvGet<{ on: boolean }>(engine.db, KILL_SWITCH_KEY)?.on ?? false;
}

/** Flips the kill switch and logs it; no-op when already in the requested state. */
export function setKillSwitch(engine: Engine, on: boolean, reason: string): boolean {
  return engine.db.transaction(() => {
    if (killSwitchOn(engine) === on) return false;
    kvSet(engine.db, KILL_SWITCH_KEY, { on, reason, at: engine.clock() });
    activity(engine, { kind: 'kill-switch', token: null, title: on ? `Kill switch ON: ${reason}` : `Kill switch off: ${reason}` });
    return true;
  });
}

/** Start of the current UTC day, ms. */
export function utcDayStart(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
