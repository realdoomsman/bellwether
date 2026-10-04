/**
 * Guardian: the fast risk loop. Syncs venue positions against the book, runs the exit ladder,
 * settles positions that stay missing from the venue (liquidations), adopts interrupted opens and flags orphans
 * (shared reconcile with the trader), and trips the kill switch on the global daily loss limit.
 * Exits run regardless of the kill switch. One failing position never stops the others.
 */
import type { ActivityKind, Address, TradeAction } from '@bellwether/shared';
import { activity, newId, setKillSwitch, utcDayStart, type Engine } from '../engine.ts';
import { evaluateExit, strictestRules, type StatePatch } from '../exits.ts';
import { kvGet, kvSet } from '../db.ts';
import { shortError } from '../integrations/errors.ts';
import { errorMessage, log, publicErrorText } from '../log.ts';
import type { Venue, VenuePosition } from '../ports.ts';
import {
  insertTrade,
  openPositions,
  participantStrategies,
  pendingOpenVenues,
  sharesOf,
  updatePosition,
  type PositionRow,
} from '../positions.ts';
import { getToken } from '../tokens.ts';
import { microToUsd, usdToMicro } from '../units.ts';
import { reconcileVenue } from './trader.ts';

/** Ids of positions whose last guardian pass failed (their `risk` activity was already recorded). */
const FAILING_KEY = 'guardian.failing_positions';
/** Unrealized PnL of every position carried into the UTC day, snapshotted at the day's first full venue sync. */
const DAILY_BASELINE_KEY = 'guardian.daily_baseline';
/** positionId → consecutive guardian passes the venue did not report the position, and whether the mark crossed its liquidation price meanwhile. */
const MISSING_KEY = 'guardian.missing_positions';
/** A tracked position is settled as gone only after this many consecutive passes without it on the venue. */
export const MISSING_PASSES = 3;
/** positionId → close the guardian decided but the venue only partly filled; the rest is closed on the next pass. */
const PENDING_CLOSES_KEY = 'guardian.pending_closes';

interface DailyBaseline {
  day: number;
  /** positionId → unrealized PnL (micro-USD) at the snapshot, for positions opened before `day`. */
  baselines: Record<string, number>;
  /** Today's PnL (micro-USD) when an operator reset the daily loss: the limit counts from there. */
  resetPnlMicro?: number;
}

interface Missing {
  passes: number;
  crossed: boolean;
}

export async function runGuardian(engine: Engine): Promise<string> {
  const tracked = openPositions(engine.db);
  const active = await engine.market.activeVenue();
  const venueIds = new Set([...tracked.map((p) => p.venue), ...pendingOpenVenues(engine.db)]);
  if (active) venueIds.add(active.id);

  const actions: string[] = [];
  const failures: string[] = [];
  const venueFailures: string[] = [];
  const failed = new Map<string, string>();
  const attempted = new Set<string>();
  // Unread venues keep their counts; positions closed since drop out.
  const missingBefore = kvGet<Record<string, Missing>>(engine.db, MISSING_KEY) ?? {};
  const missing: Record<string, Missing> = Object.fromEntries(tracked.filter((p) => missingBefore[p.id]).map((p) => [p.id, missingBefore[p.id]!]));
  const reads: { venue: Venue; live: VenuePosition[] }[] = [];
  for (const venueId of venueIds) {
    const venue = engine.io.venues.find((v) => v.id === venueId);
    if (!venue) {
      for (const p of tracked.filter((x) => x.venue === venueId)) {
        attempted.add(p.id);
        failed.set(p.id, `venue ${venueId} not configured`);
      }
      continue;
    }
    try {
      reads.push({ venue, live: await venue.positions() });
    } catch (err) {
      venueFailures.push(`${venue.name} positions: ${publicErrorText(shortError(err))}`);
      log.error('guardian could not read venue positions', { venue: venueId, error: errorMessage(err) });
    }
  }
  // Fresh marks, before any exit this pass books realized PnL.
  const baseline = dailyBaseline(engine, tracked, reads);

  for (const { venue, live } of reads) {
    const positions = tracked.filter((x) => x.venue === venue.id);
    const liveBySymbol = new Map(live.map((p) => [p.symbol, p]));
    for (const p of positions) {
      attempted.add(p.id);
      try {
        const lp = liveBySymbol.get(p.market);
        if (lp) {
          delete missing[p.id];
          const done = await manage(engine, venue, p, lp);
          if (done) actions.push(done);
          continue;
        }
        // One read without the position is not proof it is gone (a lagging or glitched API node): settling it would
        // abandon a live position as an unmanaged orphan. It is settled once it stays missing for MISSING_PASSES, as a
        // liquidation if the mark was through its liquidation price on any of those passes.
        const quote = await engine.market.quote(p.market).catch(() => null);
        const price = quote?.price ?? p.markPrice;
        const dir = p.side === 'long' ? 1 : -1;
        const crossed = p.liquidationPrice !== null && dir * (price - p.liquidationPrice) <= 0;
        const state = { passes: (missingBefore[p.id]?.passes ?? 0) + 1, crossed: (missingBefore[p.id]?.crossed ?? false) || crossed };
        missing[p.id] = state;
        if (state.passes < MISSING_PASSES) {
          log.warn('tracked position missing on venue; settling once confirmed', { market: p.market, passes: state.passes });
          actions.push(`${p.market} missing on venue (${state.passes}/${MISSING_PASSES})`);
          continue;
        }
        actions.push(settleMissing(engine, p, price, state.crossed));
      } catch (err) {
        failed.set(p.id, publicErrorText(shortError(err)));
        log.error('guardian action failed', { market: p.market, error: errorMessage(err) });
      }
    }
    const r = reconcileVenue(engine, venue, live, new Set(positions.map((p) => p.market)));
    actions.push(...r.adopted.map((s) => `${s} adopted`));
    failures.push(...r.failures);
  }
  if (JSON.stringify(missing) !== JSON.stringify(missingBefore)) kvSet(engine.db, MISSING_KEY, missing);
  reportFailing(engine, tracked, attempted, failed);
  for (const p of tracked) {
    const error = failed.get(p.id);
    if (error) failures.push(`${p.market}: ${error}`);
  }

  if (baseline) checkDailyLoss(engine, baseline);
  const done = actions.length ? actions.join(', ') : `${tracked.length - failed.size} positions healthy`;
  if (venueFailures.length) throw new Error(`guardian: ${[...venueFailures, ...failures].join('; ')} (done: ${done})`);
  return failures.length ? `${done}; ${failures.length} failed: ${failures.join('; ')}` : done;
}

/** One `risk` activity when a position starts failing; the mark clears once it is handled again. */
function reportFailing(engine: Engine, tracked: PositionRow[], attempted: Set<string>, failed: Map<string, string>): void {
  const previous = new Set(kvGet<string[]>(engine.db, FAILING_KEY) ?? []);
  // Positions not attempted this run (venue unreadable) keep their state; closed ones drop out.
  const next = tracked.filter((p) => failed.has(p.id) || (!attempted.has(p.id) && previous.has(p.id))).map((p) => p.id);
  if (next.length === previous.size && next.every((id) => previous.has(id))) return;
  engine.db.transaction(() => {
    for (const p of tracked) {
      const error = failed.get(p.id);
      if (error === undefined || previous.has(p.id)) continue;
      activity(engine, {
        kind: 'risk',
        token: soleToken(engine, sharesOf(engine.db, p.id).map((s) => s.token)),
        title: `Guardian cannot manage ${p.market} ${p.side}: ${error}`,
        market: p.market,
      });
    }
    kvSet(engine.db, FAILING_KEY, next);
  });
}

async function manage(engine: Engine, venue: Venue, p: PositionRow, lp: VenuePosition): Promise<string | null> {
  const rules = strictestRules(participantStrategies(engine.db, p.id), p.stopLoss);
  const signal = await engine.market.signal(p.market).catch(() => null);
  const decision = evaluateExit(
    {
      side: p.side,
      entryPrice: p.entryPrice,
      markPrice: lp.markPrice,
      leverage: p.leverage,
      collateralUsd: lp.collateralUsd,
      unrealizedPnlUsd: lp.unrealizedPnlUsd,
      liquidationPrice: lp.liquidationPrice,
      stage: p.stage,
      bestPrice: p.bestPrice,
      tp1Hit: p.tp1Hit,
      tp2Hit: p.tp2Hit,
      liqReduced: p.liqReduced,
    },
    { stopLoss: rules.stopLoss, ladder: rules.ladder, liquidationBufferPct: engine.config.risk.liquidationBufferPct, signalScore: signal?.score ?? null },
  );

  const sync = {
    markPrice: lp.markPrice,
    liquidationPrice: lp.liquidationPrice,
    unrealizedPnlMicro: usdToMicro(lp.unrealizedPnlUsd),
    sizeMicro: usdToMicro(lp.sizeUsd),
    collateralMicro: usdToMicro(lp.collateralUsd),
  };
  const synced = { ...p, ...sync };
  // A close the venue only partly filled last pass stands: the rest is closed now even if the ladder would hold.
  const close = decision.kind === 'close' ? decision : pendingCloses(engine)[p.id];
  if (close) {
    updatePosition(engine.db, p.id, sync);
    return exit(engine, venue, synced, 1, close.action, close.reason, null);
  }
  if (decision.kind === 'reduce') {
    updatePosition(engine.db, p.id, sync);
    return exit(engine, venue, synced, decision.fraction, decision.action, decision.reason, decision.patch);
  }
  updatePosition(engine.db, p.id, { ...sync, ...(decision.kind === 'hold' ? decision.patch : {}) });
  return null;
}

interface PendingClose {
  action: TradeAction;
  reason: string;
}

function pendingCloses(engine: Engine): Record<string, PendingClose> {
  return kvGet<Record<string, PendingClose>>(engine.db, PENDING_CLOSES_KEY) ?? {};
}

function setPendingClose(engine: Engine, positionId: string, close: PendingClose | null): void {
  const all = pendingCloses(engine);
  if (!close && !(positionId in all)) return;
  if (close) all[positionId] = close;
  else delete all[positionId];
  kvSet(engine.db, PENDING_CLOSES_KEY, all);
}

/**
 * Executes a reduce (fraction < 1) or full close on the venue and books what actually filled: an IOC order can fill
 * part of its size, and the venue can close more than asked (whole position under its minimum order). The position
 * is closed only when the venue holds none of it; a partly filled close is remembered and finished next pass. A
 * reduce's ladder step (`patch`) is recorded only when its order filled in full, so a short fill retries the step.
 */
export async function exit(
  engine: Engine,
  venue: Venue,
  p: PositionRow,
  fraction: number,
  action: TradeAction,
  reason: string,
  patch: StatePatch | null,
): Promise<string> {
  const fill = await venue.reduce(p.market, fraction, engine.config.risk.slippageBps);
  const closed = Math.min(1, fill.closedFraction);
  if (!(closed > 0)) throw new Error(`${p.market} ${reason}: venue reported closing ${fill.closedFraction} of the position`);
  const netMicro = usdToMicro(fill.realizedPnlUsd - fill.feeUsd);
  const at = engine.clock();
  const full = closed >= 1;
  const unfinished = fraction >= 1 && !full;
  engine.db.transaction(() => {
    const shares = sharesOf(engine.db, p.id);
    const tradeId = newId();
    insertTrade(engine.db, {
      id: tradeId,
      positionId: p.id,
      venue: venue.id,
      market: p.market,
      side: p.side,
      action: full && action === 'reduce' ? 'close' : !full && action === 'close' ? 'reduce' : action,
      reason,
      sizeMicro: usdToMicro(fill.sizeUsd),
      price: fill.price,
      realizedPnlMicro: netMicro,
      feeMicro: usdToMicro(fill.feeUsd),
      at,
      tx: fill.tx,
    });
    engine.ledger.recordExit({ positionId: p.id, tradeId, fraction: closed, pnlMicro: netMicro, shares, tx: fill.tx, at });
    if (full) {
      updatePosition(engine.db, p.id, { closedAt: at, closeReason: reason, unrealizedPnlMicro: 0, markPrice: fill.price });
    } else {
      // The reduced part's PnL is now realized; only the remainder stays unrealized.
      updatePosition(engine.db, p.id, {
        ...(patch && fill.complete ? patch : {}),
        sizeMicro: Math.round(p.sizeMicro * (1 - closed)),
        collateralMicro: Math.round(p.collateralMicro * (1 - closed)),
        unrealizedPnlMicro: Math.round(p.unrealizedPnlMicro * (1 - closed)),
      });
    }
    setPendingClose(engine, p.id, unfinished ? { action, reason } : null);
    const kind: ActivityKind = action === 'stop' ? 'stop' : full ? 'close' : 'reduce';
    const pnl = microToUsd(netMicro);
    const verb = full ? 'Closed' : `Reduced ${Math.round(closed * 100)}% of`;
    const rest = unfinished ? '; partial fill, closing the rest next pass' : '';
    activity(engine, {
      kind,
      token: soleToken(engine, shares.map((s) => s.token)),
      title: `${verb} ${p.market} ${p.side} (${reason}${rest}): ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
      amountUsd: pnl,
      market: p.market,
      txs: [fill.tx],
    });
  });
  return unfinished ? `${p.market} ${reason} (partial fill)` : `${p.market} ${reason}`;
}

/**
 * The venue has not reported a tracked position for MISSING_PASSES passes. If the mark crossed the liquidation
 * price meanwhile it was liquidated (collateral lost); otherwise it was closed outside the engine and is settled at
 * the current quote (`price`) so the book stays consistent (the reconciler surfaces any difference).
 */
function settleMissing(engine: Engine, p: PositionRow, price: number, liquidated: boolean): string {
  const dir = p.side === 'long' ? 1 : -1;
  const at = engine.clock();
  engine.db.transaction(() => {
    const shares = sharesOf(engine.db, p.id);
    const deployed = [...engine.ledger.deployedIn(p.id).values()].reduce((s, v) => s + v, 0);
    const estimate = Math.round((p.sizeMicro * dir * (price - p.entryPrice)) / p.entryPrice);
    const pnlMicro = liquidated ? -deployed : Math.max(-deployed, estimate);
    const reason = liquidated ? 'liquidated' : 'missing on venue — settled at mark';
    const tradeId = newId();
    insertTrade(engine.db, {
      id: tradeId,
      positionId: p.id,
      venue: p.venue,
      market: p.market,
      side: p.side,
      action: liquidated ? 'liquidated' : 'close',
      reason,
      sizeMicro: p.sizeMicro,
      price,
      realizedPnlMicro: pnlMicro,
      feeMicro: 0,
      at,
      tx: null,
    });
    engine.ledger.recordExit({ positionId: p.id, tradeId, fraction: 1, pnlMicro, shares, tx: null, at });
    setPendingClose(engine, p.id, null);
    updatePosition(engine.db, p.id, { closedAt: at, closeReason: reason, unrealizedPnlMicro: 0, markPrice: price });
    activity(engine, {
      kind: liquidated ? 'liquidated' : 'risk',
      token: soleToken(engine, shares.map((s) => s.token)),
      title: liquidated
        ? `${p.market} ${p.side} was liquidated: -$${microToUsd(deployed).toFixed(2)}`
        : `${p.market} ${p.side} disappeared from the venue; settled at $${price.toFixed(2)}`,
      amountUsd: microToUsd(pnlMicro),
      market: p.market,
    });
  });
  return `${p.market} ${liquidated ? 'liquidated' : 'settled (missing)'}`;
}

/**
 * The day's baseline: the unrealized PnL of each position carried into the UTC day, taken from the venue's fresh
 * marks at the day's first pass that read every tracked position's venue (and before that pass's exits), so moves
 * from before the snapshot, including while the engine was down, never count against today's limit. Positions
 * opened today count from their open. Null until that first full sync: the daily-loss check waits for it.
 */
function dailyBaseline(engine: Engine, tracked: PositionRow[], reads: { venue: Venue; live: VenuePosition[] }[]): DailyBaseline | null {
  const day = utcDayStart(engine.clock());
  const stored = kvGet<DailyBaseline>(engine.db, DAILY_BASELINE_KEY);
  if (stored?.day === day) return stored;
  const marks = new Map(reads.map((r) => [r.venue.id, new Map(r.live.map((lp) => [lp.symbol, lp]))]));
  if (tracked.some((p) => !marks.has(p.venue))) {
    log.warn('daily loss baseline waits for a full venue sync', { day });
    return null;
  }
  const baselines: Record<string, number> = {};
  for (const p of tracked) {
    if (p.openedAt >= day) continue;
    const lp = marks.get(p.venue)!.get(p.market);
    baselines[p.id] = lp ? usdToMicro(lp.unrealizedPnlUsd) : p.unrealizedPnlMicro;
  }
  const snapshot: DailyBaseline = { day, baselines };
  kvSet(engine.db, DAILY_BASELINE_KEY, snapshot);
  return snapshot;
}

/**
 * Today's PnL = realized since 00:00 UTC + open unrealized − the snapshot baselines. A snapshot position's
 * realized-today flows are relative to its entry, so its whole baseline is subtracted whether it is still
 * open or closed today; positions opened today count from their open.
 */
function todayPnlMicro(engine: Engine, baseline: DailyBaseline): number {
  const realized = engine.ledger.realizedSince(baseline.day);
  const unrealized = openPositions(engine.db).reduce((s, p) => s + p.unrealizedPnlMicro, 0);
  const carried = Object.values(baseline.baselines).reduce((s, v) => s + v, 0);
  return realized + unrealized - carried;
}

export interface DailyLoss {
  /** Loss counted against the limit (micro-USD; negative = a gain): since 00:00 UTC, or since an operator reset. */
  lossMicro: number;
  limitMicro: number;
}

/** Today's loss against GLOBAL_DAILY_LOSS_USD from the last synced marks; null until today's baseline exists. */
export function dailyLoss(engine: Engine): DailyLoss | null {
  const baseline = kvGet<DailyBaseline>(engine.db, DAILY_BASELINE_KEY);
  if (baseline?.day !== utcDayStart(engine.clock())) return null;
  return lossOf(engine, baseline);
}

function lossOf(engine: Engine, baseline: DailyBaseline): DailyLoss {
  return {
    lossMicro: -(todayPnlMicro(engine, baseline) - (baseline.resetPnlMicro ?? 0)),
    limitMicro: usdToMicro(engine.config.risk.globalDailyLossUsd),
  };
}

/**
 * Operator override after a daily-loss trip: the loss so far today is accepted and the limit counts again from
 * today's current PnL until 00:00 UTC. Returns the loss accepted (micro-USD), or null when today's baseline is not
 * snapshotted yet (nothing counts against the limit so far, so there is nothing to reset).
 */
export function resetDailyLoss(engine: Engine): number | null {
  const baseline = kvGet<DailyBaseline>(engine.db, DAILY_BASELINE_KEY);
  if (baseline?.day !== utcDayStart(engine.clock())) return null;
  const accepted = lossOf(engine, baseline).lossMicro;
  kvSet(engine.db, DAILY_BASELINE_KEY, { ...baseline, resetPnlMicro: todayPnlMicro(engine, baseline) });
  return accepted;
}

function checkDailyLoss(engine: Engine, baseline: DailyBaseline): void {
  const { lossMicro, limitMicro } = lossOf(engine, baseline);
  if (lossMicro >= limitMicro) {
    const since = baseline.resetPnlMicro === undefined ? '' : ' since the operator reset';
    setKillSwitch(engine, true, `daily loss $${microToUsd(lossMicro).toFixed(2)}${since} reached the $${engine.config.risk.globalDailyLossUsd} limit`);
  }
}

function soleToken(engine: Engine, tokens: Address[]): { address: Address; symbol: string } | null {
  if (tokens.length !== 1) return null;
  const t = getToken(engine.db, tokens[0]!);
  return t ? { address: t.address, symbol: t.symbol } : null;
}
