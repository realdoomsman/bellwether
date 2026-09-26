/**
 * Trader: pools the USDC budgets of eligible tokens per stock market and opens one position
 * per market when the signal clears the strictest participant's threshold. Writes every
 * active token's Decision on every run.
 *
 * Every open is preceded by a durable intent (`pending_opens`) and booked in the transaction that
 * removes it, so a fill whose booking never ran is adopted by the next reconcile (trader or guardian)
 * instead of trading unbooked. Untracked venue positions without an intent are orphans: reported once
 * and counted against the caps, never opened on top of.
 */
import {
  BRAND,
  SESSION_LABEL,
  STRATEGIES,
  effectiveLeverageCap,
  marketSession,
  type Address,
  type Decision,
} from '@stepup/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, killSwitchOn, newId, utcDayStart, type Engine } from '../engine.ts';
import { shortError } from '../integrations/errors.ts';
import { emptyBook, type Book, type TxLike } from '../ledger.ts';
import { errorMessage, log } from '../log.ts';
import type { Fill, Venue, VenueMarket, VenuePosition } from '../ports.ts';
import {
  deletePendingOpen,
  insertPendingOpen,
  insertPosition,
  insertShares,
  insertTrade,
  openPositions,
  pendingOpenVenues,
  pendingOpens,
  sharesOf,
  type PendingOpenRow,
  type PositionRow,
} from '../positions.ts';
import { decision, getToken, listTokens, updateToken, type TokenRow } from '../tokens.ts';
import { allocate, gweiToEth, microToUsd, usdToMicro } from '../units.ts';

const ORPHANS_KEY = 'guardian.reported_orphans';
/** An intent this old with nothing to adopt is dropped so it cannot claim an unrelated later position. */
const INTENT_TTL_MS = 10 * 60_000;

interface Member {
  token: TokenRow;
  book: Book;
}

export async function runTrader(engine: Engine): Promise<string> {
  const { db, ledger } = engine;
  const now = engine.clock();
  const session = marketSession(new Date(now));
  const kill = killSwitchOn(engine);
  const venue = await engine.market.activeVenue();

  // Reconcile first: adoptions become tracked positions below, orphans occupy their market and the caps.
  const adopted: string[] = [];
  const orphans: VenuePosition[] = [];
  let blind: string | null = null;
  const reconcileIds = new Set(pendingOpenVenues(db));
  if (venue) reconcileIds.add(venue.id);
  for (const v of engine.io.venues.filter((x) => reconcileIds.has(x.id))) {
    try {
      const tracked = new Set(openPositions(db).filter((p) => p.venue === v.id).map((p) => p.market));
      const r = reconcileVenue(engine, v, await v.positions(), tracked);
      adopted.push(...r.adopted);
      orphans.push(...r.untracked);
    } catch (err) {
      log.warn('trader could not reconcile venue positions', { venue: v.id, error: errorMessage(err) });
      if (v === venue) blind = shortError(err);
    }
  }

  const books = ledger.books();
  const open = openPositions(db);
  const positionOf = new Map<Address, PositionRow>();
  for (const p of open) for (const s of sharesOf(db, p.id)) positionOf.set(s.token, p);
  const dayStart = utcDayStart(now);

  const decisions = new Map<Address, Decision>();
  const decide = (t: TokenRow, verdict: Decision['verdict'], message: string, signal?: { score: number; threshold: number }) =>
    decisions.set(t.address, decision(verdict, message, now, signal));
  const pools = new Map<string, Member[]>();

  for (const t of listTokens(db, ['active'])) {
    const book = books.get(t.address) ?? emptyBook();
    const strategy = STRATEGIES[t.strategy];
    const position = positionOf.get(t.address);
    if (!strategy.trades) {
      decide(t, 'burn-only', `Burn-only: fees buy back and burn $${t.symbol} and $${BRAND.ticker}; no trading`);
      continue;
    }
    if (position) {
      decide(t, 'in-position', `In the pooled ${position.market} ${position.side} at ${position.leverage}x`);
      continue;
    }
    if (kill) {
      decide(t, 'kill-switch', 'Kill switch is on: no new positions until it is cleared');
      continue;
    }
    const todayLoss = -Math.min(0, ledger.realizedSince(dayStart, t.address));
    const dayEquity = book.trading_usd + book.deployed_usd + todayLoss;
    if (todayLoss > 0 && todayLoss >= strategy.dailyLossLimit * dayEquity) {
      decide(t, 'daily-loss-limit', `Lost $${microToUsd(todayLoss).toFixed(2)} today (limit ${(strategy.dailyLossLimit * 100).toFixed(0)}% of budget); resumes at 00:00 UTC`);
      continue;
    }
    if (!strategy.sessions.includes(session)) {
      const allowed = strategy.sessions.map((s) => SESSION_LABEL[s].toLowerCase()).join(', ');
      decide(t, 'waiting-session', `${strategy.label} enters only during ${allowed}; now: ${SESSION_LABEL[session].toLowerCase()}`);
      continue;
    }
    if (t.side !== 'long') {
      decide(t, 'waiting-signal', 'Short pools are not available yet');
      continue;
    }
    if (book.trading_usd <= 0) {
      decide(
        t,
        'collecting-fees',
        book.trading_eth > 0
          ? `${gweiToEth(book.trading_eth).toFixed(5)} ETH of trading budget waiting to be bridged to USDC`
          : 'Waiting for creator fees to fund a trading budget',
      );
      continue;
    }
    const members = pools.get(t.market) ?? [];
    members.push({ token: t, book });
    pools.set(t.market, members);
  }

  const opened: string[] = [];
  if (pools.size > 0) {
    const venueMarkets = venue ? await engine.market.venueMarkets() : [];
    const caps = {
      freeMicro: venue ? usdToMicro(await venue.freeCollateralUsd()) : 0,
      // Orphans hold venue margin the ledger does not know about: they count against the caps.
      deployedMicro: ledger.totals().deployed_usd + orphans.reduce((s, o) => s + usdToMicro(o.collateralUsd), 0),
      openCount: open.length + orphans.length,
    };
    const openMarkets = new Set(open.map((p) => p.market));
    const orphanMarkets = new Set(orphans.map((o) => o.symbol));

    for (const [symbol, members] of pools) {
      const all = (verdict: Decision['verdict'], message: string, signal?: { score: number; threshold: number }) => {
        for (const m of members) decide(m.token, verdict, message, signal);
      };
      if (openMarkets.has(symbol)) {
        all('waiting-signal', `A pooled ${symbol} position is already open; this budget joins the next entry`);
        continue;
      }
      if (orphanMarkets.has(symbol)) {
        all('waiting-signal', `An untracked ${symbol} position is open on the venue; no entry until it is resolved`);
        continue;
      }
      if (!venue) {
        all('venue-paused', 'No perp venue is available right now');
        continue;
      }
      if (blind) {
        all('venue-paused', `Cannot read positions on ${venue.name}: ${blind}`);
        continue;
      }
      const vm = venueMarkets.find((m) => m.symbol === symbol);
      if (!vm) {
        all('venue-paused', `${symbol} is not listed on ${venue.name}`);
        continue;
      }
      if (!vm.open) {
        all('waiting-session', `${symbol} is not trading on ${venue.name} right now`);
        continue;
      }
      try {
        const result = await tryOpen(engine, venue, vm, members, caps);
        if (result.opened) {
          opened.push(`${symbol} $${microToUsd(result.collateralMicro).toFixed(2)} @${result.leverage}x`);
          openMarkets.add(symbol);
          for (const m of members) {
            if (result.participants.has(m.token.address)) decide(m.token, 'in-position', result.message);
            else decide(m.token, 'below-minimum', `Budget too small to join the ${symbol} entry`);
          }
        } else {
          all(result.verdict, result.message, result.signal);
        }
      } catch (err) {
        all('waiting-signal', `Entry on ${symbol} failed: ${shortError(err)}`);
      }
    }
  }

  db.transaction(() => {
    for (const [address, d] of decisions) updateToken(db, address, { decision: d }, now);
  });
  const parts = [...adopted.map((s) => `adopted ${s}`), ...(opened.length ? [`opened ${opened.join(', ')}`] : [])];
  return parts.length ? parts.join('; ') : `no entries (${decisions.size} tokens evaluated)`;
}

type OpenResult =
  | { opened: true; collateralMicro: number; leverage: number; participants: Set<Address>; message: string }
  | { opened: false; verdict: Decision['verdict']; message: string; signal?: { score: number; threshold: number } };

async function tryOpen(
  engine: Engine,
  venue: Venue,
  vm: VenueMarket,
  members: Member[],
  caps: { freeMicro: number; deployedMicro: number; openCount: number },
): Promise<OpenResult> {
  const { config, db } = engine;
  const risk = config.risk;
  const symbol = vm.symbol;
  const signal = await engine.market.signal(symbol);
  const threshold = risk.baseSignalThreshold + Math.max(...members.map((m) => STRATEGIES[m.token.strategy].entryThresholdBonus));
  const sig = { score: signal.score, threshold };
  if (signal.score < threshold) {
    return { opened: false, verdict: 'waiting-signal', message: `Signal ${signal.score}/${threshold} on ${symbol} — waiting for a better entry`, signal: sig };
  }
  if (caps.openCount >= risk.maxConcurrentPositions) {
    return { opened: false, verdict: 'waiting-signal', message: `Signal ${signal.score}/${threshold} on ${symbol}, but all ${risk.maxConcurrentPositions} position slots are in use`, signal: sig };
  }

  const leverage = Math.floor(
    Math.min(signal.suggestedLeverage, vm.maxLeverage, ...members.map((m) => effectiveLeverageCap(m.token.strategy, m.token.maxLeverage, vm.maxLeverage))),
  );
  if (leverage < 1) return { opened: false, verdict: 'below-minimum', message: `Leverage caps leave no room to trade ${symbol}` };

  // Keep fee headroom in each budget so the opening fee never overdraws it.
  const headroom = 1 + (leverage * risk.feeBufferBps) / 10_000;
  const spendable = members.map((m) => Math.floor(m.book.trading_usd / headroom));
  const pool = spendable.reduce((s, v) => s + v, 0);
  const minMicro = usdToMicro(risk.minCollateralUsd);
  const remainingCap = usdToMicro(risk.maxTotalDeployedUsd) - caps.deployedMicro;
  const collateralMicro = Math.min(pool, Math.floor(caps.freeMicro / headroom), usdToMicro(risk.maxPoolCollateralUsd), remainingCap);
  if (collateralMicro < minMicro) {
    const why =
      pool < minMicro
        ? `${symbol} pool budget $${microToUsd(pool).toFixed(2)} is below the $${risk.minCollateralUsd} minimum`
        : remainingCap < minMicro
          ? `Global deployment cap of $${risk.maxTotalDeployedUsd} reached`
          : `Waiting for USDC margin on ${venue.name}`;
    return { opened: false, verdict: 'below-minimum', message: why, signal: sig };
  }

  const contributions = allocate(collateralMicro, spendable);
  const intent: PendingOpenRow = {
    id: newId(),
    venue: venue.id,
    market: symbol,
    side: 'long',
    legs: members.map((m, i) => ({ token: m.token.address, collateralMicro: contributions[i]! })).filter((l) => l.collateralMicro > 0),
    collateralMicro,
    leverage,
    stopLoss: Math.max(...members.map((m) => STRATEGIES[m.token.strategy].stopLoss)),
    entrySignal: signal.score,
    reason: `signal ${signal.score}/${threshold}`,
    createdAt: engine.clock(),
  };
  insertPendingOpen(db, intent);
  let fill: Fill;
  try {
    fill = await venue.open({ symbol, side: 'long', collateralUsd: microToUsd(collateralMicro), leverage, maxSlippageBps: risk.slippageBps });
  } catch (err) {
    // A failed request can still have filled: keep the intent for adoption unless the venue shows no position.
    const live = await venue.positions().catch(() => null);
    if (live && !live.some((x) => x.symbol === symbol)) deletePendingOpen(db, intent.id);
    throw err;
  }
  // Book the venue's liquidation price at entry: a gap through it before the guardian's first sync must still
  // settle as a liquidation. The fill is already on the venue, so a failed read must not block booking it.
  const liquidationPrice = (await venue.positions().catch(() => [])).find((x) => x.symbol === symbol)?.liquidationPrice ?? null;
  const feeMicro = usdToMicro(fill.feeUsd);
  bookOpen(engine, intent, 'Opened', {
    price: fill.price,
    sizeMicro: usdToMicro(fill.sizeUsd),
    collateralMicro,
    feeMicro,
    tx: fill.tx,
    markPrice: fill.price,
    liquidationPrice,
    unrealizedPnlMicro: 0,
  });

  caps.openCount++;
  caps.deployedMicro += collateralMicro;
  caps.freeMicro -= collateralMicro + feeMicro;
  const message = `Opened ${symbol} long at ${leverage}x on signal ${signal.score}/${threshold}`;
  return { opened: true, collateralMicro, leverage, participants: new Set(intent.legs.map((l) => l.token)), message };
}

/** An open as booked: the venue fill, or the venue's view of a position adopted from its intent. */
interface OpenFill {
  price: number;
  sizeMicro: number;
  /** Collateral on the venue; the ledger debits at most the intended collateral. */
  collateralMicro: number;
  feeMicro: number;
  /** Null when adopted: the fill itself was never read. */
  tx: TxLike | null;
  markPrice: number;
  liquidationPrice: number | null;
  unrealizedPnlMicro: number;
}

/**
 * Books an open (position, shares, trade, ledger debits, activity) and removes its intent in the same
 * transaction. Returns false without writing when the intent is already gone (booked elsewhere).
 */
function bookOpen(engine: Engine, intent: PendingOpenRow, verb: 'Opened' | 'Adopted', fill: OpenFill): boolean {
  const { db, ledger } = engine;
  // Split by the intended shares; never debit a leg more than its intended (budget-checked) collateral.
  const debit = allocate(Math.min(fill.collateralMicro, intent.collateralMicro), intent.legs.map((l) => l.collateralMicro));
  const legs = intent.legs.map((l, i) => ({ token: l.token, collateralMicro: debit[i]! })).filter((l) => l.collateralMicro > 0);
  const debited = legs.reduce((s, l) => s + l.collateralMicro, 0);
  const fees = allocate(fill.feeMicro, legs.map((l) => l.collateralMicro));
  const at = engine.clock();
  const positionId = newId();
  const tradeId = newId();
  const tx: TxLike = fill.tx ?? { chain: 'hyperliquid', hash: `adopted:${intent.id}` };
  return db.transaction(() => {
    if (!deletePendingOpen(db, intent.id)) return false;
    insertPosition(db, {
      id: positionId,
      venue: intent.venue,
      market: intent.market,
      side: intent.side,
      leverage: intent.leverage,
      entryPrice: fill.price,
      sizeMicro: fill.sizeMicro,
      collateralMicro: fill.collateralMicro,
      stage: 'open',
      bestPrice: fill.price,
      tp1Hit: false,
      tp2Hit: false,
      liqReduced: false,
      stopLoss: intent.stopLoss,
      entrySignal: intent.entrySignal,
      markPrice: fill.markPrice,
      liquidationPrice: fill.liquidationPrice,
      unrealizedPnlMicro: fill.unrealizedPnlMicro,
      openedAt: at,
      closedAt: null,
      closeReason: null,
    });
    insertShares(
      db,
      legs.map((l) => ({ positionId, token: l.token, collateralMicro: l.collateralMicro, share: l.collateralMicro / debited })),
    );
    insertTrade(db, {
      id: tradeId,
      positionId,
      venue: intent.venue,
      market: intent.market,
      side: intent.side,
      action: 'open',
      reason: intent.reason,
      sizeMicro: fill.sizeMicro,
      price: fill.price,
      realizedPnlMicro: -fill.feeMicro,
      feeMicro: fill.feeMicro,
      at,
      tx: fill.tx,
    });
    ledger.recordOpen({ positionId, tradeId, legs: legs.map((l, i) => ({ ...l, feeMicro: fees[i]! })), tx, at });
    const sole = legs.length === 1 ? getToken(db, legs[0]!.token) : null;
    activity(engine, {
      kind: 'open',
      token: sole ? { address: sole.address, symbol: sole.symbol } : null,
      title: `${verb} ${intent.market} ${intent.side} ${intent.leverage}x with $${microToUsd(debited).toFixed(2)} from ${legs.length} token${legs.length === 1 ? '' : 's'}`,
      amountUsd: microToUsd(debited),
      market: intent.market,
      txs: fill.tx ? [fill.tx] : [],
    });
    return true;
  });
}

export interface Reconciled {
  /** Markets whose pending open was booked from the venue position. */
  adopted: string[];
  /** Venue positions still untracked (orphans, failed adoptions): they occupy caps. */
  untracked: VenuePosition[];
  /** One line per failed adoption (public: short errors only). */
  failures: string[];
}

/**
 * Matches `venue`'s positions that the book does not track (`tracked` = markets with an open DB position on
 * it) against pending opens: an intent is adopted, a position without one is an orphan (reported once), and
 * intents left with nothing to adopt past INTENT_TTL_MS are dropped. Idempotent. Runs only from the trader and
 * guardian, which share the scheduler's execution lock, so it never sees an order still in flight.
 */
export function reconcileVenue(engine: Engine, venue: Venue, live: VenuePosition[], tracked: Set<string>): Reconciled {
  const out: Reconciled = { adopted: [], untracked: [], failures: [] };
  const intents = new Map(pendingOpens(engine.db, venue.id).map((i) => [i.market, i]));
  const orphans: VenuePosition[] = [];
  for (const lp of live.filter((x) => !tracked.has(x.symbol))) {
    const intent = intents.get(lp.symbol);
    intents.delete(lp.symbol);
    if (!intent || intent.side !== lp.side) {
      orphans.push(lp);
      out.untracked.push(lp);
      continue;
    }
    try {
      const booked = bookOpen(engine, intent, 'Adopted', {
        price: lp.entryPrice,
        sizeMicro: usdToMicro(lp.sizeUsd),
        collateralMicro: usdToMicro(lp.collateralUsd),
        feeMicro: 0,
        tx: null,
        markPrice: lp.markPrice,
        liquidationPrice: lp.liquidationPrice,
        unrealizedPnlMicro: usdToMicro(lp.unrealizedPnlUsd),
      });
      if (booked) out.adopted.push(lp.symbol);
    } catch (err) {
      out.untracked.push(lp);
      out.failures.push(`adopting ${lp.symbol}: ${shortError(err)}`);
      log.error('adopting pending open failed', { venue: venue.id, market: lp.symbol, error: errorMessage(err) });
    }
  }
  const now = engine.clock();
  for (const intent of intents.values()) {
    if (now - intent.createdAt >= INTENT_TTL_MS) deletePendingOpen(engine.db, intent.id);
  }
  reportOrphans(engine, venue, orphans);
  return out;
}

/** One `risk` activity per orphan while it lasts; a position that disappears and returns is reported again. */
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
