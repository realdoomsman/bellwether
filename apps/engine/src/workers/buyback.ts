/**
 * Buyback: spends each active token's buyback budget on its own token and the pooled protocol-token
 * budget on the protocol token, always sending the proceeds to the burn address.
 *
 * Safety rules:
 * - A swap that landed is always booked, even when its burn failed: the bought tokens are then held as a
 *   pending burn and the burn alone is retried on later runs. A budget is never spent twice.
 * - Each swap only spends ETH the wallet holds beyond the gas reserve and every other reservation
 *   (trading ETH, other tokens' buyback budgets), so a shortfall can't be covered with someone else's ETH.
 * - The kill switch is re-checked before every swap. Finishing pending burns is always allowed.
 * - A price-guard refusal (manipulated or too-thin pool) is a skip, not a failure: the budget waits.
 */
import { BRAND, type Address } from '@stepup/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, killSwitchOn, type Engine } from '../engine.ts';
import { shortError } from '../integrations/errors.ts';
import { PriceGuardError } from '../integrations/index.ts';
import type { TxLike } from '../ledger.ts';
import { log } from '../log.ts';
import { insertBurn } from '../positions.ts';
import { getToken, listTokens, type TokenRow } from '../tokens.ts';
import { allocate, ethToGwei, gweiToEth, gweiToMicroAt, gweiToWei, microToUsd, rawToUnits, weiToGwei } from '../units.ts';

const NO_POOL_KEY = 'buyback.no_pool';
const PENDING_BURNS_KEY = 'buyback.pending_burns';
/** Launchpad tokens (and the protocol token) are standard 18-decimal ERC-20s. */
const DEFAULT_DECIMALS = 18;

/** Tokens bought by a landed swap whose burn transfer failed; stored as JSON in kv. */
interface PendingBurn {
  refId: string;
  kind: 'token' | 'protocol';
  target: Address;
  symbol: string;
  decimals: number;
  /** Raw units held by the wallet, as a decimal string. */
  amountOut: string;
  swapTx: TxLike;
  at: number;
  legs: { token: Address; gwei: number; out: string; usdMicro: number }[];
}

/** ETH the wallet may spend right now without touching the gas reserve or other reservations. */
interface Funds {
  walletGwei: number;
  reservedGwei: number;
}

export async function runBuyback(engine: Engine): Promise<string> {
  const { config, io, ledger } = engine;
  const done: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];

  await retryPendingBurns(engine, done, failures);

  if (killSwitchOn(engine)) return summarize(['kill switch on: buybacks paused', ...done], skipped, failures);
  const minGwei = ethToGwei(config.risk.buybackMinEth);
  const balances = await io.wallet.balances();
  const ethUsd = await engine.market.ethUsd();
  const books = ledger.books();
  let reservedGwei = 0;
  for (const b of books.values()) reservedGwei += b.trading_eth + b.token_buyback_eth + b.protocol_buyback_eth;
  const funds: Funds = { walletGwei: ethToGwei(balances.rhcEth) - ethToGwei(config.risk.rhcGasReserveEth), reservedGwei };

  const attempt = async (label: string, run: () => Promise<string | null>) => {
    if (killSwitchOn(engine)) {
      skipped.push(`${label}: kill switch on`);
      return;
    }
    try {
      const r = await run();
      if (r) done.push(r);
    } catch (err) {
      if (err instanceof PriceGuardError) {
        skipped.push(`${label}: ${err.message}`);
        log.info('buyback skipped by price guard', { target: label, kind: err.kind, reason: err.message });
        return;
      }
      failures.push(`${label}: ${shortError(err)}`);
      log.warn('buyback failed', { target: label, error: shortError(err) });
    }
  };

  for (const t of listTokens(engine.db, ['active'])) {
    const gwei = books.get(t.address)?.token_buyback_eth ?? 0;
    if (gwei < minGwei) continue;
    await attempt(`$${t.symbol}`, () => buyToken(engine, t, gwei, ethUsd, funds));
  }
  if (config.protocolToken) {
    const target = config.protocolToken;
    await attempt(`$${BRAND.ticker}`, () => buyProtocolToken(engine, target, minGwei, ethUsd, funds));
  }

  if (failures.length && done.length === 0) throw new Error(`buybacks failed: ${failures.join('; ')}`);
  return summarize(done, skipped, failures);
}

function summarize(done: string[], skipped: string[], failures: string[]): string {
  const parts = [done.length ? done.join(', ') : 'no budget ready'];
  if (skipped.length) parts.push(`skipped: ${skipped.join('; ')}`);
  if (failures.length) parts.push(`failed: ${failures.join('; ')}`);
  return parts.join('; ');
}

/** True when spending `gwei` of a budget that is itself part of `reservedGwei` leaves every other reservation covered. */
function canSpend(funds: Funds, gwei: number): boolean {
  return funds.walletGwei - (funds.reservedGwei - gwei) >= gwei;
}

function spend(funds: Funds, gwei: number): void {
  funds.walletGwei -= gwei;
  funds.reservedGwei -= gwei;
}

async function buyToken(engine: Engine, t: TokenRow, gwei: number, ethUsd: number, funds: Funds): Promise<string | null> {
  if (!canSpend(funds, gwei)) return `$${t.symbol} waiting for RHC balance`;
  const quote = await engine.io.dex.quote(t.address, gweiToWei(gwei));
  if (!quote) {
    noteNoPool(engine, t, gwei);
    return null;
  }
  const res = await engine.io.dex.buyAndBurn(t.address, gweiToWei(gwei), engine.config.risk.buybackSlippageBps);
  const spent = Math.min(gwei, weiToGwei(res.amountInWei));
  const usdMicro = gweiToMicroAt(spent, ethUsd);
  book(engine, {
    refId: res.swapTx.hash,
    kind: 'token',
    target: t.address,
    symbol: t.symbol,
    decimals: t.decimals,
    amountOut: res.amountOut.toString(),
    swapTx: res.swapTx,
    at: engine.clock(),
    legs: [{ token: t.address, gwei: spent, out: res.amountOut.toString(), usdMicro }],
  }, res.burnTx);
  spend(funds, spent);
  return `$${t.symbol} ${gweiToEth(spent)} ETH${res.burnTx ? '' : ' (burn pending)'}`;
}

/** One swap for the protocol-token budgets of every token; each funding token gets its pro-rata share of the burn. */
async function buyProtocolToken(engine: Engine, target: Address, minGwei: number, ethUsd: number, funds: Funds): Promise<string | null> {
  const legs = [...engine.ledger.books()].filter(([, b]) => b.protocol_buyback_eth > 0).map(([token, b]) => ({ token, gwei: b.protocol_buyback_eth }));
  const total = legs.reduce((s, l) => s + l.gwei, 0);
  if (total < minGwei) return null;
  if (!canSpend(funds, total)) return `$${BRAND.ticker} waiting for RHC balance`;
  const quote = await engine.io.dex.quote(target, gweiToWei(total));
  if (!quote) return `$${BRAND.ticker} has no pool yet`;

  const res = await engine.io.dex.buyAndBurn(target, gweiToWei(total), engine.config.risk.buybackSlippageBps);
  const spent = Math.min(total, weiToGwei(res.amountInWei));
  const spentLegs = allocate(spent, legs.map((l) => l.gwei));
  const outShares = allocateBig(res.amountOut, spentLegs);
  const usdLegs = allocate(gweiToMicroAt(spent, ethUsd), spentLegs);
  book(engine, {
    refId: res.swapTx.hash,
    kind: 'protocol',
    target,
    symbol: BRAND.ticker,
    decimals: getToken(engine.db, target)?.decimals ?? DEFAULT_DECIMALS,
    amountOut: res.amountOut.toString(),
    swapTx: res.swapTx,
    at: engine.clock(),
    legs: legs
      .map((l, i) => ({ token: l.token, gwei: spentLegs[i]!, out: outShares[i]!.toString(), usdMicro: usdLegs[i]! }))
      .filter((l) => l.gwei > 0),
  }, res.burnTx);
  spend(funds, spent);
  return `$${BRAND.ticker} ${gweiToEth(spent)} ETH${res.burnTx ? '' : ' (burn pending)'}`;
}

/** Books a landed swap. With a burn tx the burn is recorded now; without one it becomes a pending burn. */
function book(engine: Engine, p: PendingBurn, burnTx: TxLike | null): void {
  const spentGwei = p.legs.reduce((s, l) => s + l.gwei, 0);
  const usdMicro = p.legs.reduce((s, l) => s + l.usdMicro, 0);
  const units = rawToUnits(BigInt(p.amountOut), p.decimals);
  engine.db.transaction(() => {
    engine.ledger.recordBuyback({
      refId: p.refId,
      kind: p.kind,
      legs: p.legs.map((l) => ({ token: l.token, gwei: l.gwei })),
      tx: p.swapTx,
      at: p.at,
    });
    const from = p.kind === 'protocol' ? ` (from ${p.legs.length} tokens)` : '';
    if (burnTx) {
      insertBurns(engine, p, burnTx);
      activity(engine, {
        kind: 'buyback',
        token: p.kind === 'token' ? { address: p.target, symbol: p.symbol } : null,
        title: `Bought back and burned ${formatAmount(units)} $${p.symbol} for ${gweiToEth(spentGwei).toFixed(5)} ETH${from}`,
        amountEth: gweiToEth(spentGwei),
        amountUsd: microToUsd(usdMicro),
        tokensBurned: units,
        txs: [p.swapTx, burnTx],
      });
    } else {
      kvSet(engine.db, PENDING_BURNS_KEY, [...pendingBurns(engine), p]);
      activity(engine, {
        kind: 'buyback',
        token: p.kind === 'token' ? { address: p.target, symbol: p.symbol } : null,
        title: `Bought back ${formatAmount(units)} $${p.symbol} for ${gweiToEth(spentGwei).toFixed(5)} ETH${from}; the burn failed and will be retried`,
        amountEth: gweiToEth(spentGwei),
        amountUsd: microToUsd(usdMicro),
        txs: [p.swapTx],
      });
    }
    if (p.kind === 'token') clearNoPool(engine, p.target);
  });
}

function insertBurns(engine: Engine, p: PendingBurn, burnTx: TxLike): void {
  for (const l of p.legs) {
    insertBurn(engine.db, {
      at: p.at,
      token: l.token,
      target: p.target,
      kind: p.kind,
      amountInGwei: l.gwei,
      amountOut: BigInt(l.out),
      decimals: p.decimals,
      usdMicro: l.usdMicro,
      refId: p.refId,
      swapTx: p.swapTx,
      burnTx,
    });
  }
}

function pendingBurns(engine: Engine): PendingBurn[] {
  return kvGet<PendingBurn[]>(engine.db, PENDING_BURNS_KEY) ?? [];
}

/** Burns tokens held from earlier swaps whose burn failed. Never spends ETH, so it runs even with the kill switch on. */
async function retryPendingBurns(engine: Engine, done: string[], failures: string[]): Promise<void> {
  for (const p of pendingBurns(engine)) {
    try {
      const burnTx = await engine.io.dex.burnHeld(p.target, BigInt(p.amountOut));
      const units = rawToUnits(BigInt(p.amountOut), p.decimals);
      engine.db.transaction(() => {
        insertBurns(engine, p, burnTx);
        kvSet(engine.db, PENDING_BURNS_KEY, pendingBurns(engine).filter((q) => q.refId !== p.refId));
        activity(engine, {
          kind: 'buyback',
          token: p.kind === 'token' ? { address: p.target, symbol: p.symbol } : null,
          title: `Burned ${formatAmount(units)} $${p.symbol} held from an earlier buyback`,
          tokensBurned: units,
          txs: [p.swapTx, burnTx],
        });
      });
      done.push(`$${p.symbol} pending burn`);
    } catch (err) {
      failures.push(`$${p.symbol} pending burn: ${shortError(err)}`);
      log.warn('pending burn failed', { target: p.target, refId: p.refId, error: shortError(err) });
    }
  }
}

function noteNoPool(engine: Engine, t: TokenRow, gwei: number): void {
  const noted = kvGet<string[]>(engine.db, NO_POOL_KEY) ?? [];
  if (noted.includes(t.address)) return;
  engine.db.transaction(() => {
    kvSet(engine.db, NO_POOL_KEY, [...noted, t.address]);
    // Expected before a token graduates to a DEX pool: informational, not a risk event (risk events page the operator).
    activity(engine, {
      kind: 'buyback',
      token: { address: t.address, symbol: t.symbol },
      title: `No DEX pool for $${t.symbol} yet: ${gweiToEth(gwei).toFixed(5)} ETH buyback budget is held until it graduates`,
      amountEth: gweiToEth(gwei),
    });
  });
}

function clearNoPool(engine: Engine, token: Address): void {
  const noted = kvGet<string[]>(engine.db, NO_POOL_KEY) ?? [];
  if (noted.includes(token)) kvSet(engine.db, NO_POOL_KEY, noted.filter((a) => a !== token));
}

/** Pro-rata split of a raw token amount; parts sum exactly to `total`. */
function allocateBig(total: bigint, weights: readonly number[]): bigint[] {
  const sum = BigInt(weights.reduce((s, w) => s + w, 0));
  if (sum === 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (total * BigInt(w)) / sum);
  const rest = total - parts.reduce((s, p) => s + p, 0n);
  const largest = weights.indexOf(Math.max(...weights));
  parts[largest] = parts[largest]! + rest;
  return parts;
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}
