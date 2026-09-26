/**
 * Trader: pools the USDC budgets of eligible tokens per stock market and opens one position
 * per market when the signal clears the strictest participant's threshold. Writes every
 * active token's Decision on every run.
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
import { activity, killSwitchOn, newId, utcDayStart, type Engine } from '../engine.ts';
import { emptyBook, type Book } from '../ledger.ts';
import { errorMessage } from '../log.ts';
import type { Venue, VenueMarket } from '../ports.ts';
import { insertPosition, insertShares, insertTrade, openPositions, sharesOf, type PositionRow } from '../positions.ts';
import { decision, listTokens, updateToken, type TokenRow } from '../tokens.ts';
import { allocate, gweiToEth, microToUsd, usdToMicro } from '../units.ts';

interface Member {
  token: TokenRow;
  book: Book;
}

export async function runTrader(engine: Engine): Promise<string> {
  const { db, ledger } = engine;
  const now = engine.clock();
  const session = marketSession(new Date(now));
  const kill = killSwitchOn(engine);
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
    const venue = await engine.market.activeVenue();
    const venueMarkets = venue ? await engine.market.venueMarkets() : [];
    const caps = {
      freeMicro: venue ? usdToMicro(await venue.freeCollateralUsd()) : 0,
      deployedMicro: ledger.totals().deployed_usd,
      openCount: open.length,
    };
    const openMarkets = new Set(open.map((p) => p.market));

    for (const [symbol, members] of pools) {
      const all = (verdict: Decision['verdict'], message: string, signal?: { score: number; threshold: number }) => {
        for (const m of members) decide(m.token, verdict, message, signal);
      };
      if (openMarkets.has(symbol)) {
        all('waiting-signal', `A pooled ${symbol} position is already open; this budget joins the next entry`);
        continue;
      }
      if (!venue) {
        all('venue-paused', 'No perp venue is available right now');
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
        all('waiting-signal', `Entry on ${symbol} failed: ${errorMessage(err)}`);
      }
    }
  }

  db.transaction(() => {
    for (const [address, d] of decisions) updateToken(db, address, { decision: d }, now);
  });
  return opened.length ? `opened ${opened.join(', ')}` : `no entries (${decisions.size} tokens evaluated)`;
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
  const { config, db, ledger } = engine;
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
  const legs = members
    .map((m, i) => ({ token: m.token.address, collateralMicro: contributions[i]! }))
    .filter((l) => l.collateralMicro > 0);
  const fill = await venue.open({
    symbol,
    side: 'long',
    collateralUsd: microToUsd(collateralMicro),
    leverage,
    maxSlippageBps: risk.slippageBps,
  });
  // Book the venue's liquidation price at entry: a gap through it before the guardian's first sync must still
  // settle as a liquidation. The fill is already on the venue, so a failed read must not block booking it.
  const liquidationPrice = (await venue.positions().catch(() => [])).find((x) => x.symbol === symbol)?.liquidationPrice ?? null;

  const at = engine.clock();
  const positionId = newId();
  const tradeId = newId();
  const feeMicro = usdToMicro(fill.feeUsd);
  const fees = allocate(feeMicro, legs.map((l) => l.collateralMicro));
  const stopLoss = Math.max(...members.map((m) => STRATEGIES[m.token.strategy].stopLoss));
  const message = `Opened ${symbol} long at ${leverage}x on signal ${signal.score}/${threshold}`;
  const symbols = new Map(members.map((m) => [m.token.address, m.token.symbol]));

  db.transaction(() => {
    insertPosition(db, {
      id: positionId,
      venue: venue.id,
      market: symbol,
      side: 'long',
      leverage,
      entryPrice: fill.price,
      sizeMicro: usdToMicro(fill.sizeUsd),
      collateralMicro,
      stage: 'open',
      bestPrice: fill.price,
      tp1Hit: false,
      tp2Hit: false,
      liqReduced: false,
      stopLoss,
      entrySignal: signal.score,
      markPrice: fill.price,
      liquidationPrice,
      unrealizedPnlMicro: 0,
      openedAt: at,
      closedAt: null,
      closeReason: null,
    });
    insertShares(
      db,
      legs.map((l) => ({ positionId, token: l.token, collateralMicro: l.collateralMicro, share: l.collateralMicro / collateralMicro })),
    );
    insertTrade(db, {
      id: tradeId,
      positionId,
      venue: venue.id,
      market: symbol,
      side: 'long',
      action: 'open',
      reason: `signal ${signal.score}/${threshold}`,
      sizeMicro: usdToMicro(fill.sizeUsd),
      price: fill.price,
      realizedPnlMicro: -feeMicro,
      feeMicro,
      at,
      tx: fill.tx,
    });
    ledger.recordOpen({
      positionId,
      tradeId,
      legs: legs.map((l, i) => ({ ...l, feeMicro: fees[i]! })),
      tx: fill.tx,
      at,
    });
    activity(engine, {
      kind: 'open',
      token: legs.length === 1 ? { address: legs[0]!.token, symbol: symbols.get(legs[0]!.token)! } : null,
      title: `Opened ${symbol} long ${leverage}x with $${microToUsd(collateralMicro).toFixed(2)} from ${legs.length} token${legs.length === 1 ? '' : 's'}`,
      amountUsd: microToUsd(collateralMicro),
      market: symbol,
      txs: [fill.tx],
    });
  });

  caps.openCount++;
  caps.deployedMicro += collateralMicro;
  caps.freeMicro -= collateralMicro + feeMicro;
  return { opened: true, collateralMicro, leverage, participants: new Set(legs.map((l) => l.token)), message };
}
