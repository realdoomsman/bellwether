/**
 * Buyback: spends each active token's buyback budget on its own token and the pooled protocol-token
 * budget on the protocol token, always sending the proceeds to the burn address. Blocked by the kill switch.
 */
import { BRAND, type Address } from '@stepup/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, killSwitchOn, type Engine } from '../engine.ts';
import { errorMessage, log } from '../log.ts';
import { insertBurn } from '../positions.ts';
import { getToken, listTokens, type TokenRow } from '../tokens.ts';
import { allocate, ethToGwei, gweiToEth, gweiToMicroAt, gweiToWei, microToUsd, rawToUnits, weiToGwei } from '../units.ts';

const NO_POOL_KEY = 'buyback.no_pool';
/** Launchpad tokens (and the protocol token) are standard 18-decimal ERC-20s. */
const DEFAULT_DECIMALS = 18;

export async function runBuyback(engine: Engine): Promise<string> {
  if (killSwitchOn(engine)) return 'kill switch on: buybacks paused';
  const { config, io, ledger } = engine;
  const minGwei = ethToGwei(config.risk.buybackMinEth);
  const balances = await io.wallet.balances();
  const ethUsd = await engine.market.ethUsd();
  const budget = { spendableGwei: Math.max(0, ethToGwei(balances.rhcEth) - ethToGwei(config.risk.rhcGasReserveEth)) };
  const books = ledger.books();
  const done: string[] = [];
  const failures: string[] = [];

  for (const t of listTokens(engine.db, ['active'])) {
    const gwei = books.get(t.address)?.token_buyback_eth ?? 0;
    if (gwei < minGwei) continue;
    try {
      const r = await buyToken(engine, t, gwei, ethUsd, budget);
      if (r) done.push(r);
    } catch (err) {
      failures.push(`${t.symbol}: ${errorMessage(err)}`);
      log.warn('buyback failed', { token: t.address, error: errorMessage(err) });
    }
  }

  if (config.protocolToken) {
    try {
      const r = await buyProtocolToken(engine, config.protocolToken, minGwei, ethUsd, budget);
      if (r) done.push(r);
    } catch (err) {
      failures.push(`$${BRAND.ticker}: ${errorMessage(err)}`);
      log.warn('protocol token buyback failed', { error: errorMessage(err) });
    }
  }

  if (failures.length && done.length === 0) throw new Error(`buybacks failed: ${failures.join('; ')}`);
  const summary = done.length ? done.join(', ') : 'no budget ready';
  return failures.length ? `${summary}; failed: ${failures.join('; ')}` : summary;
}

async function buyToken(engine: Engine, t: TokenRow, gwei: number, ethUsd: number, budget: { spendableGwei: number }): Promise<string | null> {
  if (gwei > budget.spendableGwei) return `$${t.symbol} waiting for RHC balance`;
  const quote = await engine.io.dex.quote(t.address, gweiToWei(gwei));
  if (!quote) {
    noteNoPool(engine, t, gwei);
    return null;
  }
  const res = await engine.io.dex.buyAndBurn(t.address, gweiToWei(gwei), engine.config.risk.buybackSlippageBps);
  const spent = Math.min(gwei, weiToGwei(res.amountInWei));
  const at = engine.clock();
  const burned = rawToUnits(res.amountOut, t.decimals);
  const usdMicro = gweiToMicroAt(spent, ethUsd);
  engine.db.transaction(() => {
    engine.ledger.recordBuyback({ refId: res.swapTx.hash, kind: 'token', legs: [{ token: t.address, gwei: spent }], tx: res.swapTx, at });
    insertBurn(engine.db, {
      at,
      token: t.address,
      target: t.address,
      kind: 'token',
      amountInGwei: spent,
      amountOut: res.amountOut,
      decimals: t.decimals,
      usdMicro,
      refId: res.swapTx.hash,
      swapTx: res.swapTx,
      burnTx: res.burnTx,
    });
    activity(engine, {
      kind: 'buyback',
      token: { address: t.address, symbol: t.symbol },
      title: `Bought back and burned ${formatAmount(burned)} $${t.symbol} for ${gweiToEth(spent).toFixed(5)} ETH`,
      amountEth: gweiToEth(spent),
      amountUsd: microToUsd(usdMicro),
      tokensBurned: burned,
      txs: [res.swapTx, res.burnTx],
    });
    clearNoPool(engine, t.address);
  });
  budget.spendableGwei -= spent;
  return `$${t.symbol} ${gweiToEth(spent)} ETH`;
}

/** One swap for the protocol-token budgets of every token; each funding token gets its pro-rata share of the burn. */
async function buyProtocolToken(engine: Engine, target: Address, minGwei: number, ethUsd: number, budget: { spendableGwei: number }): Promise<string | null> {
  const legs = [...engine.ledger.books()].filter(([, b]) => b.protocol_buyback_eth > 0).map(([token, b]) => ({ token, gwei: b.protocol_buyback_eth }));
  const total = legs.reduce((s, l) => s + l.gwei, 0);
  if (total < minGwei) return null;
  if (total > budget.spendableGwei) return `$${BRAND.ticker} waiting for RHC balance`;
  const quote = await engine.io.dex.quote(target, gweiToWei(total));
  if (!quote) return `$${BRAND.ticker} has no pool yet`;

  const res = await engine.io.dex.buyAndBurn(target, gweiToWei(total), engine.config.risk.buybackSlippageBps);
  const spent = Math.min(total, weiToGwei(res.amountInWei));
  const spentLegs = allocate(spent, legs.map((l) => l.gwei));
  const decimals = getToken(engine.db, target)?.decimals ?? DEFAULT_DECIMALS;
  const outShares = allocateBig(res.amountOut, spentLegs);
  const usdLegs = allocate(gweiToMicroAt(spent, ethUsd), spentLegs);
  const burned = rawToUnits(res.amountOut, decimals);
  const at = engine.clock();
  engine.db.transaction(() => {
    const paid = legs.map((l, i) => ({ token: l.token, gwei: spentLegs[i]! })).filter((l) => l.gwei > 0);
    engine.ledger.recordBuyback({ refId: res.swapTx.hash, kind: 'protocol', legs: paid, tx: res.swapTx, at });
    legs.forEach((l, i) => {
      if (spentLegs[i]! <= 0) return;
      insertBurn(engine.db, {
        at,
        token: l.token,
        target,
        kind: 'protocol',
        amountInGwei: spentLegs[i]!,
        amountOut: outShares[i]!,
        decimals,
        usdMicro: usdLegs[i]!,
        refId: res.swapTx.hash,
        swapTx: res.swapTx,
        burnTx: res.burnTx,
      });
    });
    activity(engine, {
      kind: 'buyback',
      token: null,
      title: `Bought back and burned ${formatAmount(burned)} $${BRAND.ticker} for ${gweiToEth(spent).toFixed(5)} ETH (from ${paid.length} tokens)`,
      amountEth: gweiToEth(spent),
      amountUsd: microToUsd(gweiToMicroAt(spent, ethUsd)),
      tokensBurned: burned,
      txs: [res.swapTx, res.burnTx],
    });
  });
  budget.spendableGwei -= spent;
  return `$${BRAND.ticker} ${gweiToEth(spent)} ETH`;
}

function noteNoPool(engine: Engine, t: TokenRow, gwei: number): void {
  const noted = kvGet<string[]>(engine.db, NO_POOL_KEY) ?? [];
  if (noted.includes(t.address)) return;
  engine.db.transaction(() => {
    kvSet(engine.db, NO_POOL_KEY, [...noted, t.address]);
    activity(engine, {
      kind: 'risk',
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
