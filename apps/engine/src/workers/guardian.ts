/**
 * Guardian: the fast risk loop. Syncs venue positions against the book, runs the exit ladder,
 * settles positions that vanished (liquidations), flags orphans, and trips the kill switch on
 * the global daily loss limit. Exits run regardless of the kill switch.
 */
import type { ActivityKind, Address, TradeAction } from '@stepup/shared';
import { activity, newId, setKillSwitch, utcDayStart, type Engine } from '../engine.ts';
import { evaluateExit, strictestRules, type StatePatch } from '../exits.ts';
import { kvGet, kvSet } from '../db.ts';
import { errorMessage, log } from '../log.ts';
import type { Venue, VenuePosition } from '../ports.ts';
import {
  insertTrade,
  openPositions,
  participantStrategies,
  sharesOf,
  updatePosition,
  type PositionRow,
} from '../positions.ts';
import { getToken } from '../tokens.ts';
import { microToUsd, usdToMicro } from '../units.ts';

const ORPHANS_KEY = 'guardian.reported_orphans';

export async function runGuardian(engine: Engine): Promise<string> {
  const tracked = openPositions(engine.db);
  const active = await engine.market.activeVenue();
  const venueIds = new Set(tracked.map((p) => p.venue));
  if (active) venueIds.add(active.id);

  const actions: string[] = [];
  const failures: string[] = [];
  for (const venueId of venueIds) {
    const venue = engine.io.venues.find((v) => v.id === venueId);
    if (!venue) {
      failures.push(`venue ${venueId} not configured`);
      continue;
    }
    const live = await venue.positions();
    const liveBySymbol = new Map(live.map((p) => [p.symbol, p]));
    for (const p of tracked.filter((x) => x.venue === venueId)) {
      try {
        const lp = liveBySymbol.get(p.market);
        liveBySymbol.delete(p.market);
        const done = lp ? await manage(engine, venue, p, lp) : await settleMissing(engine, p);
        if (done) actions.push(done);
      } catch (err) {
        failures.push(`${p.market}: ${errorMessage(err)}`);
        log.error('guardian action failed', { market: p.market, error: errorMessage(err) });
      }
    }
    reportOrphans(engine, venue, [...liveBySymbol.values()]);
  }

  checkDailyLoss(engine);
  if (failures.length) throw new Error(`guardian: ${failures.join('; ')}${actions.length ? ` (done: ${actions.join(', ')})` : ''}`);
  return actions.length ? actions.join(', ') : `${tracked.length} positions healthy`;
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

function reportOrphans(engine: Engine, venue: Venue, orphans: VenuePosition[]): void {
  const prefix = `${venue.id}:`;
  const previous = kvGet<string[]>(engine.db, ORPHANS_KEY) ?? [];
  const reported = new Set(previous.filter((k) => k.startsWith(prefix)));
  const current = orphans.map((o) => `${prefix}${o.symbol}:${o.side}`);
  engine.db.transaction(() => {
    for (const [i, o] of orphans.entries()) {
      if (reported.has(current[i]!)) continue;
      activity(engine, {
        kind: 'risk',
        token: null,
        title: `Untracked ${o.symbol} ${o.side} ($${o.sizeUsd.toFixed(2)}) found on ${venue.name}; not managed by the engine`,
        amountUsd: o.sizeUsd,
        market: o.symbol,
      });
    }
    kvSet(engine.db, ORPHANS_KEY, [...previous.filter((k) => !k.startsWith(prefix)), ...current]);
  });
}

function checkDailyLoss(engine: Engine): void {
  const realized = engine.ledger.realizedSince(utcDayStart(engine.clock()));
  const unrealized = openPositions(engine.db).reduce((s, p) => s + p.unrealizedPnlMicro, 0);
  const loss = -(realized + unrealized);
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
