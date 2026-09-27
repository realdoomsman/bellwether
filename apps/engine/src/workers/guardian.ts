/**
 * Guardian: the fast risk loop. Syncs venue positions against the book, runs the exit ladder,
 * settles positions that vanished (liquidations), adopts interrupted opens and flags orphans
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
/** Unrealized PnL of every position open at the first guardian run of the UTC day. */
const DAILY_BASELINE_KEY = 'guardian.daily_baseline';

interface DailyBaseline {
  day: number;
  /** positionId → unrealized PnL (micro-USD) at the snapshot. */
  baselines: Record<string, number>;
}

export async function runGuardian(engine: Engine): Promise<string> {
  const baseline = dailyBaseline(engine);
  const tracked = openPositions(engine.db);
  const active = await engine.market.activeVenue();
  const venueIds = new Set([...tracked.map((p) => p.venue), ...pendingOpenVenues(engine.db)]);
  if (active) venueIds.add(active.id);

  const actions: string[] = [];
  const failures: string[] = [];
  const venueFailures: string[] = [];
  const failed = new Map<string, string>();
  const attempted = new Set<string>();
  for (const venueId of venueIds) {
    const positions = tracked.filter((x) => x.venue === venueId);
    const venue = engine.io.venues.find((v) => v.id === venueId);
    if (!venue) {
      for (const p of positions) {
        attempted.add(p.id);
        failed.set(p.id, `venue ${venueId} not configured`);
      }
      continue;
    }
    let live: VenuePosition[];
    try {
      live = await venue.positions();
    } catch (err) {
      venueFailures.push(`${venue.name} positions: ${publicErrorText(shortError(err))}`);
      log.error('guardian could not read venue positions', { venue: venueId, error: errorMessage(err) });
      continue;
    }
    const liveBySymbol = new Map(live.map((p) => [p.symbol, p]));
    for (const p of positions) {
      attempted.add(p.id);
      try {
        const lp = liveBySymbol.get(p.market);
        const done = lp ? await manage(engine, venue, p, lp) : await settleMissing(engine, p);
        if (done) actions.push(done);
      } catch (err) {
        failed.set(p.id, publicErrorText(shortError(err)));
        log.error('guardian action failed', { market: p.market, error: errorMessage(err) });
      }
    }
    const r = reconcileVenue(engine, venue, live, new Set(positions.map((p) => p.market)));
    actions.push(...r.adopted.map((s) => `${s} adopted`));
    failures.push(...r.failures);
  }
  reportFailing(engine, tracked, attempted, failed);
  for (const p of tracked) {
    const error = failed.get(p.id);
    if (error) failures.push(`${p.market}: ${error}`);
  }

  checkDailyLoss(engine, baseline);
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
  if (decision.kind === 'hold') {
    updatePosition(engine.db, p.id, { ...sync, ...decision.patch });
    return null;
  }
  updatePosition(engine.db, p.id, sync);
  const synced = { ...p, ...sync };
  if (decision.kind === 'reduce') return exit(engine, venue, synced, decision.fraction, decision.action, decision.reason, decision.patch);
  return exit(engine, venue, synced, 1, decision.action, decision.reason, null);
}

/** Executes a reduce (fraction < 1) or full close on the venue and books it. */
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
  const netMicro = usdToMicro(fill.realizedPnlUsd - fill.feeUsd);
  const at = engine.clock();
  const full = fraction >= 1;
  engine.db.transaction(() => {
    const shares = sharesOf(engine.db, p.id);
    const tradeId = newId();
    insertTrade(engine.db, {
      id: tradeId,
      positionId: p.id,
      venue: venue.id,
      market: p.market,
      side: p.side,
      action: full && action === 'reduce' ? 'close' : action,
      reason,
      sizeMicro: usdToMicro(fill.sizeUsd),
      price: fill.price,
      realizedPnlMicro: netMicro,
      feeMicro: usdToMicro(fill.feeUsd),
      at,
      tx: fill.tx,
    });
    engine.ledger.recordExit({ positionId: p.id, tradeId, fraction: full ? 1 : fraction, pnlMicro: netMicro, shares, tx: fill.tx, at });
    if (full) {
      updatePosition(engine.db, p.id, { closedAt: at, closeReason: reason, unrealizedPnlMicro: 0, markPrice: fill.price });
    } else {
      // The reduced part's PnL is now realized; only the remainder stays unrealized.
      updatePosition(engine.db, p.id, {
        ...(patch ?? {}),
        sizeMicro: Math.round(p.sizeMicro * (1 - fraction)),
        collateralMicro: Math.round(p.collateralMicro * (1 - fraction)),
        unrealizedPnlMicro: Math.round(p.unrealizedPnlMicro * (1 - fraction)),
      });
    }
    const kind: ActivityKind = action === 'stop' ? 'stop' : full ? 'close' : 'reduce';
    const pnl = microToUsd(netMicro);
    const verb = full ? 'Closed' : `Reduced ${Math.round(fraction * 100)}% of`;
    activity(engine, {
      kind,
      token: soleToken(engine, shares.map((s) => s.token)),
      title: `${verb} ${p.market} ${p.side} (${reason}): ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
      amountUsd: pnl,
      market: p.market,
      txs: [fill.tx],
    });
  });
  return `${p.market} ${reason}`;
}

/**
 * The venue no longer reports a tracked position. If the mark crossed the liquidation price it
 * was liquidated (collateral lost); otherwise it was closed outside the engine and is settled at
 * the current quote so the book stays consistent (the reconciler surfaces any difference).
 */
async function settleMissing(engine: Engine, p: PositionRow): Promise<string> {
  const quote = await engine.market.quote(p.market).catch(() => null);
  const price = quote?.price ?? p.markPrice;
  const dir = p.side === 'long' ? 1 : -1;
  const liquidated = p.liquidationPrice !== null && dir * (price - p.liquidationPrice) <= 0;
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
 * The day's baseline, snapshotted at the first run of each UTC day from the last synced marks (before this
 * run's sync), so losses carried over from earlier days do not count against today's limit.
 */
function dailyBaseline(engine: Engine): DailyBaseline {
  const day = utcDayStart(engine.clock());
  const stored = kvGet<DailyBaseline>(engine.db, DAILY_BASELINE_KEY);
  if (stored?.day === day) return stored;
  const snapshot: DailyBaseline = { day, baselines: Object.fromEntries(openPositions(engine.db).map((p) => [p.id, p.unrealizedPnlMicro])) };
  kvSet(engine.db, DAILY_BASELINE_KEY, snapshot);
  return snapshot;
}

/**
 * Today's PnL = realized since 00:00 UTC + open unrealized − the snapshot baselines. A snapshot position's
 * realized-today flows are relative to its entry, so its whole baseline is subtracted whether it is still
 * open or closed today; positions opened after the snapshot count from their open.
 */
function checkDailyLoss(engine: Engine, baseline: DailyBaseline): void {
  const realized = engine.ledger.realizedSince(baseline.day);
  const unrealized = openPositions(engine.db).reduce((s, p) => s + p.unrealizedPnlMicro, 0);
  const carried = Object.values(baseline.baselines).reduce((s, v) => s + v, 0);
  const loss = -(realized + unrealized - carried);
  const limit = usdToMicro(engine.config.risk.globalDailyLossUsd);
  if (loss >= limit) {
    setKillSwitch(engine, true, `daily loss $${microToUsd(loss).toFixed(2)} reached the $${engine.config.risk.globalDailyLossUsd} limit`);
  }
}

function soleToken(engine: Engine, tokens: Address[]): { address: Address; symbol: string } | null {
  if (tokens.length !== 1) return null;
  const t = getToken(engine.db, tokens[0]!);
  return t ? { address: t.address, symbol: t.symbol } : null;
}
