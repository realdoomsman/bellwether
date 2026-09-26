/** Claims creator fees for active tokens and books the fee split. */
import { activity, type Engine } from '../engine.ts';
import { errorMessage, log } from '../log.ts';
import { insertBurn } from '../positions.ts';
import { listTokens, type TokenRow } from '../tokens.ts';
import { ethToGwei, gweiToEth, gweiToWei, rawToUnits, usdToMicro } from '../units.ts';

export async function runClaimer(engine: Engine): Promise<string> {
  const tokens = listTokens(engine.db, ['active']);
  const minWei = gweiToWei(ethToGwei(engine.config.risk.claimMinEth));
  let claimed = 0;
  let totalGwei = 0;
  const failures: string[] = [];

  for (const t of tokens) {
    try {
      const got = await claimToken(engine, t, minWei);
      if (got > 0) {
        claimed++;
        totalGwei += got;
      }
    } catch (err) {
      failures.push(`${t.symbol}: ${errorMessage(err)}`);
      log.warn('claim failed', { token: t.address, error: errorMessage(err) });
    }
  }

  if (failures.length > 0 && failures.length === tokens.length) throw new Error(`all claims failed: ${failures.join('; ')}`);
  const summary = `claimed ${gweiToEth(totalGwei)} ETH from ${claimed}/${tokens.length} tokens`;
  return failures.length ? `${summary}; ${failures.length} failed (${failures.join('; ')})` : summary;
}

/** Returns gwei claimed (0 when below threshold or nothing to claim). */
async function claimToken(engine: Engine, t: TokenRow, minWei: bigint): Promise<number> {
  const launchpad = engine.io.launchpads[t.launchpad];
  const claimable = await launchpad.claimable(t.address);
  if (claimable === null || claimable <= 0n || claimable < minWei) return 0;
  const res = await launchpad.claim(t.address);
  if (!res || res.amountWei <= 0n) return 0;

  // Launchpad LP fees can also pay out in the token itself; those are burned by the claim.
  let burnedUsd = 0;
  let burnedUnits = 0;
  if (res.tokensBurned) {
    burnedUnits = rawToUnits(res.tokensBurned.amount, t.decimals);
    const market = await engine.market.tokenMarket(t.address).catch(() => null);
    burnedUsd = market?.priceUsd ? burnedUnits * market.priceUsd : 0;
  }

  const at = engine.clock();
  return engine.db.transaction(() => {
    const split = engine.ledger.recordClaim({ token: t.address, strategy: t.strategy, amountWei: res.amountWei, tx: res.tx, at });
    if (!split) return 0;
    if (res.tokensBurned) {
      insertBurn(engine.db, {
        at,
        token: t.address,
        target: t.address,
        kind: 'claim',
        amountInGwei: 0,
        amountOut: res.tokensBurned.amount,
        decimals: t.decimals,
        usdMicro: usdToMicro(burnedUsd),
        refId: res.tx.hash,
        swapTx: null,
        burnTx: res.tokensBurned.tx,
      });
    }
    const eth = gweiToEth(split.totalGwei);
    activity(engine, {
      kind: 'claim',
      token: { address: t.address, symbol: t.symbol },
      title: `Claimed ${eth.toFixed(5)} ETH in creator fees for $${t.symbol}`,
      amountEth: eth,
      ...(res.tokensBurned ? { tokensBurned: burnedUnits } : {}),
      txs: res.tokensBurned ? [res.tx, res.tokensBurned.tx] : [res.tx],
    });
    return split.totalGwei;
  });
}
