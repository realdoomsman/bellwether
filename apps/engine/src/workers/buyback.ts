/**
 * Buyback: spends each active token's buyback budget on its own token and the pooled protocol-token
 * budget on the protocol token, always sending the proceeds to the burn address.
 *
 * Safety rules:
 * - A swap is recorded as a pending swap the moment it is broadcast. One whose outcome never came back (receipt
 *   timeout, crash) is looked up by hash on later runs, and its tokens' budgets wait until it resolves: a landed
 *   swap is booked (its tokens become a pending burn), a reverted or dropped one is cleared. A budget is never
 *   spent twice.
 * - A swap that landed is always booked, even when its burn failed: the bought tokens are then held as a
 *   pending burn and the burn alone is retried on later runs (also for memecoin a claim could not burn). A burn
 *   is likewise recorded when broadcast and looked up before any retry, and a retry burns at most what the
 *   wallet still holds, recording the amount actually burned.
 * - Every tx's Robinhood Chain gas is booked against the budgets it served.
 * - Each swap only spends ETH the wallet holds beyond the gas reserve and every other reservation
 *   (trading ETH, other tokens' buyback budgets), so a shortfall can't be covered with someone else's ETH.
 * - The kill switch is re-checked before every swap. Finishing pending swaps and burns is always allowed.
 * - A price-guard refusal (manipulated or too-thin pool) is a skip, not a failure: the budget waits. V4 pools
 *   keep no on-chain TWAP, so every run samples their price and a V4 buy waits until those samples cover the
 *   V3 TWAP window.
 */
import { BRAND, type Address } from '@bellwether/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, killSwitchOn, type Engine } from '../engine.ts';
import { shortError } from '../integrations/errors.ts';
import { PriceGuardError, TWAP_WINDOW_SEC } from '../integrations/index.ts';
import type { EthBudget, TxLike } from '../ledger.ts';
import { log } from '../log.ts';
import type { BroadcastTx, BuybackResult } from '../ports.ts';
import { insertBurn } from '../positions.ts';
import { getToken, listTokens, type TokenRow } from '../tokens.ts';
import { allocate, ethToGwei, gweiToEth, gweiToMicroAt, gweiToWei, microToUsd, rawToUnits, weiToGwei } from '../units.ts';

const NO_POOL_KEY = 'buyback.no_pool';
const PENDING_BURNS_KEY = 'buyback.pending_burns';
const PENDING_SWAPS_KEY = 'buyback.pending_swaps';
const SPOT_SAMPLES_KEY = 'buyback.spot_samples';
/** Launchpad tokens (and the protocol token) are standard 18-decimal ERC-20s. */
const DEFAULT_DECIMALS = 18;
/** A broadcast reported dropped (nonce taken by another tx) is trusted only this long after it was sent: RPC replicas lag. */
const DROP_GRACE_MS = 15 * 60_000;
/** V4 rolling reference: samples must span the V3 TWAP window, at least this many, none older than SAMPLE_MAX_AGE_MS. */
export const REFERENCE_SPAN_MS = TWAP_WINDOW_SEC * 1000;
export const SAMPLE_MAX_AGE_MS = 3 * REFERENCE_SPAN_MS;
export const MIN_SAMPLES = 3;

type BurnKind = 'token' | 'protocol' | 'claim';

/** A broadcast tx whose outcome is not known yet, with when it was sent. */
interface Broadcast extends BroadcastTx {
  at: number;
}

/** Tokens the wallet holds that must still be burned (a landed swap or a claim whose burn failed); JSON in kv. */
export interface PendingBurn {
  refId: string;
  kind: BurnKind;
  target: Address;
  symbol: string;
  decimals: number;
  /** Raw units held by the wallet, as a decimal string. */
  amountOut: string;
  /** The buyback swap; null for claimed memecoin. */
  swapTx: TxLike | null;
  at: number;
  legs: { token: Address; gwei: number; out: string; usdMicro: number }[];
  /** A burn of these tokens that was broadcast but never confirmed: looked up before burning again. */
  burnTx?: Broadcast | null;
}

/** A buyback swap broadcast but not yet booked; JSON in kv. */
interface PendingSwap extends Broadcast {
  kind: 'token' | 'protocol';
  target: Address;
  symbol: string;
  decimals: number;
  /** ETH each funding token's budget put in (gwei). */
  legs: { token: Address; gwei: number }[];
}

export interface SpotSample {
  at: number;
  /** Raw token units per wei. */
  price: number;
}

/** ETH the wallet may spend right now without touching the gas reserve or other reservations. */
interface Funds {
  walletGwei: number;
  reservedGwei: number;
}

const BUDGET: Record<BurnKind, EthBudget> = { token: 'token_buyback_eth', protocol: 'protocol_buyback_eth', claim: 'token_buyback_eth' };

export async function runBuyback(engine: Engine): Promise<string> {
  const { config, io, ledger } = engine;
  const done: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];

  await resolvePendingSwaps(engine, done, skipped, failures);
  await retryPendingBurns(engine, done, skipped, failures);
  const tokens = listTokens(engine.db, ['active']);
  await sampleSpotPrices(engine, [...tokens.map((t) => t.address), ...(config.protocolToken ? [config.protocolToken] : [])]);

  if (killSwitchOn(engine)) return summarize(['kill switch on: buybacks paused', ...done], skipped, failures);
  const minGwei = ethToGwei(config.risk.buybackMinEth);
  const balances = await io.wallet.balances();
  const ethUsd = await engine.market.ethUsd();
  const books = ledger.books();
  let reservedGwei = 0;
  // Gas advanced from the float has already left the wallet: those budgets are not backed by ETH until a claim repays it.
  for (const b of books.values()) reservedGwei += b.trading_eth + b.token_buyback_eth + b.protocol_buyback_eth - b.gas_debt_eth;
  const funds: Funds = { walletGwei: ethToGwei(balances.rhcEth) - ethToGwei(config.risk.rhcGasReserveEth), reservedGwei };
  const inFlight = pendingSwaps(engine);

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

  for (const t of tokens) {
    const gwei = books.get(t.address)?.token_buyback_eth ?? 0;
    if (gwei < minGwei) continue;
    if (inFlight.some((s) => s.kind === 'token' && s.target === t.address)) {
      skipped.push(`$${t.symbol}: an earlier swap is still unresolved`);
      continue;
    }
    await attempt(`$${t.symbol}`, () => buyToken(engine, t, gwei, ethUsd, funds));
  }
  if (config.protocolToken) {
    const target = config.protocolToken;
    if (inFlight.some((s) => s.kind === 'protocol')) skipped.push(`$${BRAND.ticker}: an earlier swap is still unresolved`);
    else await attempt(`$${BRAND.ticker}`, () => buyProtocolToken(engine, target, minGwei, ethUsd, funds));
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
  const legs = [{ token: t.address, gwei }];
  const res = await swap(engine, { kind: 'token', target: t.address, symbol: t.symbol, decimals: t.decimals, legs }, gwei);
  const spent = Math.min(gwei, weiToGwei(res.amountInWei));
  const usdMicro = gweiToMicroAt(spent, ethUsd);
  book(
    engine,
    {
      refId: res.swapTx.hash,
      kind: 'token',
      target: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      amountOut: res.amountOut.toString(),
      swapTx: res.swapTx,
      at: engine.clock(),
      legs: [{ token: t.address, gwei: spent, out: res.amountOut.toString(), usdMicro }],
    },
    res,
  );
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

  const decimals = getToken(engine.db, target)?.decimals ?? DEFAULT_DECIMALS;
  const res = await swap(engine, { kind: 'protocol', target, symbol: BRAND.ticker, decimals, legs }, total);
  const spent = Math.min(total, weiToGwei(res.amountInWei));
  const spentLegs = allocate(spent, legs.map((l) => l.gwei));
  const outShares = allocateBig(res.amountOut, spentLegs.map(BigInt));
  const usdLegs = allocate(gweiToMicroAt(spent, ethUsd), spentLegs);
  book(
    engine,
    {
      refId: res.swapTx.hash,
      kind: 'protocol',
      target,
      symbol: BRAND.ticker,
      decimals,
      amountOut: res.amountOut.toString(),
      swapTx: res.swapTx,
      at: engine.clock(),
      legs: legs
        .map((l, i) => ({ token: l.token, gwei: spentLegs[i]!, out: outShares[i]!.toString(), usdMicro: usdLegs[i]! }))
        .filter((l) => l.gwei > 0),
    },
    res,
  );
  spend(funds, spent);
  return `$${BRAND.ticker} ${gweiToEth(spent)} ETH${res.burnTx ? '' : ' (burn pending)'}`;
}

/**
 * Runs the Dex buyback with the V4 rolling reference, recording the swap as pending the moment it is broadcast.
 * A price-guard refusal that still mined a preparatory tx books that gas before rethrowing.
 */
async function swap(engine: Engine, s: Omit<PendingSwap, 'hash' | 'nonce' | 'at'>, gwei: number): Promise<BuybackResult> {
  const referencePrice = v4Reference(engine, s.target);
  try {
    return await engine.io.dex.buyAndBurn(s.target, gweiToWei(gwei), engine.config.risk.buybackSlippageBps, {
      referencePrice,
      onSwapBroadcast: (tx) => kvSet(engine.db, PENDING_SWAPS_KEY, [...pendingSwaps(engine), { ...s, ...tx, at: engine.clock() }]),
    });
  } catch (err) {
    if (err instanceof PriceGuardError && err.spent) {
      engine.ledger.recordGas({ refId: err.spent.tx.hash, legs: s.legs, gasWei: err.spent.gasWei, prefer: BUDGET[s.kind], tx: err.spent.tx, at: engine.clock() });
    }
    throw err;
  }
}

/**
 * Books a landed swap and its gas, and clears its pending-swap record. With a burn tx the burn is recorded now;
 * without one the bought tokens become a pending burn.
 */
function book(engine: Engine, p: PendingBurn, res: { burnTx: TxLike | null; gasWei: bigint; burnUnconfirmed?: BroadcastTx | null }): void {
  const spentGwei = p.legs.reduce((s, l) => s + l.gwei, 0);
  const usdMicro = p.legs.reduce((s, l) => s + l.usdMicro, 0);
  const units = rawToUnits(BigInt(p.amountOut), p.decimals);
  const { burnTx } = res;
  engine.db.transaction(() => {
    if (p.legs.length > 0) {
      const budget = BUDGET[p.kind];
      // Gas booked by other workers since the swap was broadcast may have drawn on these budgets; never overdraw.
      const debits = p.legs.map((l) => ({ token: l.token, gwei: Math.min(l.gwei, engine.ledger.balance(l.token, budget)) })).filter((l) => l.gwei > 0);
      const debited = debits.reduce((s, l) => s + l.gwei, 0);
      if (debited < spentGwei) {
        log.warn('buyback debits less budget than the swap spent', { tx: p.refId, spentGwei, debitedGwei: debited });
        activity(engine, {
          kind: 'risk',
          token: p.kind === 'protocol' ? null : { address: p.target, symbol: p.symbol },
          title: `Buyback swap ${p.refId} spent ${gweiToEth(spentGwei).toFixed(5)} ETH but its ${budget} budget held only ${gweiToEth(debited).toFixed(5)} ETH; the shortfall is unbooked`,
          amountEth: gweiToEth(spentGwei - debited),
          txs: [p.swapTx!],
        });
      }
      if (debits.length > 0) engine.ledger.recordBuyback({ refId: p.refId, kind: p.kind === 'protocol' ? 'protocol' : 'token', legs: debits, tx: p.swapTx!, at: p.at });
      engine.ledger.recordGas({ refId: p.refId, legs: p.legs, gasWei: res.gasWei, prefer: BUDGET[p.kind], tx: p.swapTx, at: p.at });
    }
    kvSet(engine.db, PENDING_SWAPS_KEY, pendingSwaps(engine).filter((s) => s.hash !== p.refId));
    const from = p.kind === 'protocol' ? ` (from ${p.legs.length} tokens)` : '';
    const token = p.kind === 'protocol' ? null : { address: p.target, symbol: p.symbol };
    const bought = `Bought back ${formatAmount(units)} $${p.symbol} for ${gweiToEth(spentGwei).toFixed(5)} ETH${from}`;
    if (burnTx) {
      insertBurns(engine, p, burnTx);
      activity(engine, {
        kind: 'buyback',
        token,
        title: `Bought back and burned ${formatAmount(units)} $${p.symbol} for ${gweiToEth(spentGwei).toFixed(5)} ETH${from}`,
        amountEth: gweiToEth(spentGwei),
        amountUsd: microToUsd(usdMicro),
        tokensBurned: units,
        txs: [p.swapTx!, burnTx],
      });
    } else if (BigInt(p.amountOut) > 0n) {
      const burn = res.burnUnconfirmed ? { ...res.burnUnconfirmed, at: engine.clock() } : null;
      holdForBurn(engine, { ...p, burnTx: burn });
      activity(engine, {
        kind: 'buyback',
        token,
        title: `${bought}; the burn ${burn ? 'is unconfirmed and will be checked' : 'failed and will be retried'}`,
        amountEth: gweiToEth(spentGwei),
        amountUsd: microToUsd(usdMicro),
        txs: [p.swapTx!],
      });
    } else {
      log.error('Buyback swap landed but credited no tokens; nothing to burn', { target: p.target, swapTx: p.refId });
      activity(engine, { kind: 'risk', token, title: `${bought}, but the swap credited no tokens`, amountEth: gweiToEth(spentGwei), txs: [p.swapTx!] });
    }
    if (p.kind === 'token') clearNoPool(engine, p.target);
  });
}

/** Records memecoin a claim received but could not burn, so the buyback worker burns it on its next run. */
export function holdForBurn(engine: Engine, p: PendingBurn): void {
  const pending = pendingBurns(engine);
  if (!pending.some((q) => q.refId === p.refId)) kvSet(engine.db, PENDING_BURNS_KEY, [...pending, p]);
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

function pendingSwaps(engine: Engine): PendingSwap[] {
  return kvGet<PendingSwap[]>(engine.db, PENDING_SWAPS_KEY) ?? [];
}

/**
 * Settles swaps whose outcome never came back: landed → booked (tokens become a pending burn, burned below),
 * reverted → its gas is booked, dropped → cleared. Still pending → its budgets keep waiting.
 */
async function resolvePendingSwaps(engine: Engine, done: string[], skipped: string[], failures: string[]): Promise<void> {
  const ethUsd = await engine.market.ethUsd().catch(() => null);
  for (const s of pendingSwaps(engine)) {
    const label = `$${s.symbol} swap ${s.hash}`;
    try {
      const out = await engine.io.dex.lookupTx(s, s.target);
      const clear = () => kvSet(engine.db, PENDING_SWAPS_KEY, pendingSwaps(engine).filter((q) => q.hash !== s.hash));
      if (out.status === 'pending' || (out.status === 'dropped' && engine.clock() - s.at < DROP_GRACE_MS)) {
        skipped.push(`${label} not mined yet`);
      } else if (out.status === 'dropped') {
        clear();
        log.warn('Buyback swap was never mined; its budget is free again', { target: s.target, hash: s.hash });
        done.push(`${label} dropped`);
      } else if (!out.ok) {
        engine.db.transaction(() => {
          engine.ledger.recordGas({ refId: s.hash, legs: s.legs, gasWei: out.gasWei, prefer: BUDGET[s.kind], tx: out.tx, at: engine.clock() });
          clear();
        });
        done.push(`${label} reverted`);
      } else {
        const total = s.legs.reduce((sum, l) => sum + l.gwei, 0);
        const spent = Math.min(total, weiToGwei(out.valueWei));
        const spentLegs = allocate(spent, s.legs.map((l) => l.gwei));
        const outs = allocateBig(out.received, spentLegs.map(BigInt));
        const usd = allocate(ethUsd ? gweiToMicroAt(spent, ethUsd) : 0, spentLegs);
        book(
          engine,
          {
            refId: s.hash,
            kind: s.kind,
            target: s.target,
            symbol: s.symbol,
            decimals: s.decimals,
            amountOut: out.received.toString(),
            swapTx: out.tx,
            at: engine.clock(),
            legs: s.legs.map((l, i) => ({ token: l.token, gwei: spentLegs[i]!, out: outs[i]!.toString(), usdMicro: usd[i]! })).filter((l) => l.gwei > 0),
          },
          { burnTx: null, gasWei: out.gasWei },
        );
        done.push(`${label} landed`);
      }
    } catch (err) {
      failures.push(`${label}: ${shortError(err)}`);
      log.warn('pending swap lookup failed', { target: s.target, hash: s.hash, error: shortError(err) });
    }
  }
}

/**
 * Burns tokens held from earlier swaps or claims whose burn failed. A burn broadcast earlier is looked up first;
 * a new burn takes at most what the wallet holds. Never spends ETH beyond gas, so it runs even with the kill switch on.
 */
async function retryPendingBurns(engine: Engine, done: string[], skipped: string[], failures: string[]): Promise<void> {
  for (const p of pendingBurns(engine)) {
    const label = `$${p.symbol} pending burn`;
    try {
      if (p.burnTx) {
        const out = await engine.io.dex.lookupTx(p.burnTx, p.target);
        if (out.status === 'pending' || (out.status === 'dropped' && engine.clock() - p.burnTx.at < DROP_GRACE_MS)) {
          skipped.push(`${label}: burn ${p.burnTx.hash} not mined yet`);
          continue;
        }
        if (out.status === 'mined' && out.ok) {
          finishBurn(engine, p, out.burned < BigInt(p.amountOut) ? out.burned : BigInt(p.amountOut), out.tx, out.gasWei);
          done.push(label);
          continue;
        }
        engine.db.transaction(() => {
          if (out.status === 'mined') engine.ledger.recordGas({ refId: out.tx.hash, legs: p.legs, gasWei: out.gasWei, prefer: BUDGET[p.kind], tx: out.tx, at: engine.clock() });
          updateBurn(engine, p.refId, { burnTx: null });
        });
      }
      const res = await engine.io.dex.burnHeld(p.target, BigInt(p.amountOut), (tx) => updateBurn(engine, p.refId, { burnTx: { ...tx, at: engine.clock() } }));
      if (!res.tx) {
        engine.db.transaction(() => {
          updateBurn(engine, p.refId, null);
          activity(engine, {
            kind: 'risk',
            token: p.kind === 'protocol' ? null : { address: p.target, symbol: p.symbol },
            title: `Dropped a pending burn of ${formatAmount(rawToUnits(BigInt(p.amountOut), p.decimals))} $${p.symbol}: the protocol wallet no longer holds any`,
            txs: p.swapTx ? [p.swapTx] : [],
          });
        });
        failures.push(`${label}: the wallet holds none; dropped`);
        continue;
      }
      finishBurn(engine, p, res.amount, res.tx, res.gasWei);
      done.push(label);
    } catch (err) {
      failures.push(`${label}: ${shortError(err)}`);
      log.warn('pending burn failed', { target: p.target, refId: p.refId, error: shortError(err) });
    }
  }
}

/** Rewrites (or with null removes) one pending burn. */
function updateBurn(engine: Engine, refId: string, patch: Partial<PendingBurn> | null): void {
  kvSet(
    engine.db,
    PENDING_BURNS_KEY,
    pendingBurns(engine).flatMap((q) => (q.refId !== refId ? [q] : patch ? [{ ...q, ...patch }] : [])),
  );
}

/** Records a pending burn as done with the amount actually burned (legs scaled down when it was less than held). */
function finishBurn(engine: Engine, p: PendingBurn, burned: bigint, burnTx: TxLike, gasWei: bigint): void {
  const held = BigInt(p.amountOut);
  const outs = burned === held ? p.legs.map((l) => BigInt(l.out)) : allocateBig(burned, p.legs.map((l) => BigInt(l.out)));
  const legs = p.legs.map((l, i) => ({
    ...l,
    out: outs[i]!.toString(),
    usdMicro: held > 0n ? Number((BigInt(l.usdMicro) * outs[i]!) / (BigInt(l.out) || 1n)) : 0,
  }));
  const units = rawToUnits(burned, p.decimals);
  engine.db.transaction(() => {
    insertBurns(engine, { ...p, legs }, burnTx);
    engine.ledger.recordGas({ refId: burnTx.hash, legs: p.legs, gasWei, prefer: BUDGET[p.kind], tx: burnTx, at: engine.clock() });
    updateBurn(engine, p.refId, null);
    const short = burned < held ? ` (${formatAmount(rawToUnits(held - burned, p.decimals))} expected were never held)` : '';
    activity(engine, {
      kind: p.kind === 'claim' ? 'claim' : 'buyback',
      token: p.kind === 'protocol' ? null : { address: p.target, symbol: p.symbol },
      title: `Burned ${formatAmount(units)} $${p.symbol} held from an earlier ${p.kind === 'claim' ? 'fee claim' : 'buyback'}${short}`,
      tokensBurned: units,
      txs: p.swapTx ? [p.swapTx, burnTx] : [burnTx],
    });
  });
}

/**
 * Median of the spot samples taken before `now` within SAMPLE_MAX_AGE_MS, once there are at least MIN_SAMPLES of
 * them spanning REFERENCE_SPAN_MS; null until then. A median over samples minutes apart cannot be moved by pushing
 * the price for a block or two, and the current spot never counts towards its own reference.
 */
export function rollingReference(samples: readonly SpotSample[], now: number): number | null {
  const recent = samples.filter((s) => s.at < now && now - s.at <= SAMPLE_MAX_AGE_MS && s.price > 0);
  if (recent.length < MIN_SAMPLES) return null;
  const ats = recent.map((s) => s.at);
  if (Math.max(...ats) - Math.min(...ats) < REFERENCE_SPAN_MS) return null;
  const prices = recent.map((s) => s.price).sort((a, b) => a - b);
  const mid = prices.length >> 1;
  return prices.length % 2 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2;
}

/** Appends a spot sample for every V4-traded target (V3 pools carry their own TWAP) and prunes old ones. */
async function sampleSpotPrices(engine: Engine, targets: Address[]): Promise<void> {
  const now = engine.clock();
  const taken: [Address, number][] = [];
  for (const target of new Set(targets)) {
    try {
      const price = await engine.io.dex.spotPrice(target);
      if (price !== null && price > 0) taken.push([target, price]);
    } catch (err) {
      log.warn('V4 spot price sample failed', { target, error: shortError(err) });
    }
  }
  const all = kvGet<Record<string, SpotSample[]>>(engine.db, SPOT_SAMPLES_KEY) ?? {};
  for (const [target, price] of taken) (all[target] ??= []).push({ at: now, price });
  const kept: Record<string, SpotSample[]> = {};
  for (const [target, samples] of Object.entries(all)) {
    const fresh = samples.filter((s) => now - s.at <= SAMPLE_MAX_AGE_MS);
    if (fresh.length) kept[target] = fresh;
  }
  kvSet(engine.db, SPOT_SAMPLES_KEY, kept);
}

/** The V4 reference for `target` (undefined for V3 targets). Throws a price-guard skip while the samples are too few. */
function v4Reference(engine: Engine, target: Address): number | undefined {
  const samples = kvGet<Record<string, SpotSample[]>>(engine.db, SPOT_SAMPLES_KEY)?.[target];
  if (!samples?.length) return undefined;
  const ref = rollingReference(samples, engine.clock());
  if (ref === null) {
    throw new PriceGuardError('no-twap', `collecting V4 price history (${samples.length} samples; need ${MIN_SAMPLES} spanning ${TWAP_WINDOW_SEC}s)`);
  }
  return ref;
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
function allocateBig(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (total * w) / sum);
  const rest = total - parts.reduce((s, p) => s + p, 0n);
  let largest = 0;
  weights.forEach((w, i) => {
    if (w > weights[largest]!) largest = i;
  });
  parts[largest] = parts[largest]! + rest;
  return parts;
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}
