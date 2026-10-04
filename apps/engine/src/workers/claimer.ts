/**
 * Claims creator fees for active tokens and books the fee split (net of the claim's gas).
 *
 * Every claim call is recorded (kv `claimer.pending_claims`) the moment it is broadcast and cleared in the
 * transaction that books it. One whose receipt never came back (timeout, crash) is looked up by later runs before
 * anything else is claimed: mined → its payout and gas are booked once, under its own hash; reverted → gas only;
 * dropped → cleared after DROP_GRACE_MS. While one is still pending no new claim is sent: its payout would land
 * inside the balance window a new claim measures.
 */
import type { Address, LaunchpadId } from '@bellwether/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, type Engine } from '../engine.ts';
import { shortError } from '../integrations/errors.ts';
import { errorMessage, log } from '../log.ts';
import type { BroadcastTx, ClaimResult } from '../ports.ts';
import { insertBurn } from '../positions.ts';
import { getToken, listTokens, type TokenRow } from '../tokens.ts';
import { ethToGwei, gweiToEth, gweiToWei, rawToUnits, usdToMicro } from '../units.ts';
import { holdForBurn } from './buyback.ts';

const PENDING_CLAIMS_KEY = 'claimer.pending_claims';
/** A broadcast reported dropped (nonce taken by another tx) is trusted only this long after it was sent: RPC replicas lag. */
const DROP_GRACE_MS = 15 * 60_000;

/** A claim call broadcast but not yet booked; JSON in kv. */
interface PendingClaim extends BroadcastTx {
  token: Address;
  launchpad: LaunchpadId;
  at: number;
}

export async function runClaimer(engine: Engine): Promise<string> {
  const tokens = listTokens(engine.db, ['active']);
  const minWei = gweiToWei(ethToGwei(engine.config.risk.claimMinEth));
  let claimed = 0;
  let totalGwei = 0;
  const failures: string[] = [];

  const settled = await resolvePendingClaims(engine, failures);
  totalGwei += settled.gwei;
  if (settled.waiting.length > 0) {
    // A lookup that keeps failing stalls every claim: fail the run so the scheduler's failure alerts see it.
    if (failures.length > 0) throw new Error(`claims paused, pending claim lookup failed: ${failures.join('; ')}`);
    return `${settled.waiting.join('; ')}; new claims wait`;
  }

  for (const t of tokens) {
    try {
      const got = await claimToken(engine, t, minWei);
      if (got > 0) {
        claimed++;
        totalGwei += got;
      }
    } catch (err) {
      failures.push(`${t.symbol}: ${shortError(err)}`);
      log.warn('claim failed', { token: t.address, error: errorMessage(err) });
    }
  }

  if (failures.length > 0 && failures.length === tokens.length) throw new Error(`all claims failed: ${failures.join('; ')}`);
  const late = settled.booked > 0 ? `; ${settled.booked} earlier claim tx${settled.booked === 1 ? '' : 's'} settled` : '';
  const summary = `claimed ${gweiToEth(totalGwei)} ETH from ${claimed}/${tokens.length} tokens${late}`;
  return failures.length ? `${summary}; ${failures.length} failed (${failures.join('; ')})` : summary;
}

/** Returns gwei claimed (0 when below threshold, nothing to claim, or the claim paid only memecoin). */
async function claimToken(engine: Engine, t: TokenRow, minWei: bigint): Promise<number> {
  const launchpad = engine.io.launchpads[t.launchpad];
  const preview = launchpad.claimablePreview
    ? await launchpad.claimablePreview(t.address)
    : await launchpad.claimable(t.address).then((wei) => (wei === null ? null : { wei, tokens: 0n }));
  // claimMinEth gates the ETH leg only: memecoin fees (e.g. a Pons V2 escrow holding only released
  // buyback-vault tokens) are claimed and burned whenever there are any.
  if (!preview || ((preview.wei <= 0n || preview.wei < minWei) && preview.tokens <= 0n)) return 0;
  const res = await launchpad.claim(t.address, (tx) =>
    kvSet(engine.db, PENDING_CLAIMS_KEY, [...pendingClaims(engine), { ...tx, token: t.address, launchpad: t.launchpad, at: engine.clock() }]),
  );
  if (!res) return 0;
  // Every call this claim broadcast is in `res` except one still unconfirmed, which stays pending for a later lookup.
  const settles = (p: PendingClaim) => p.token === t.address && p.hash !== res.unconfirmed?.hash;
  return bookClaim(engine, t, res, settles, false);
}

/**
 * Books a claim (or a claim call settled late) and clears the pending records `settles` matches, in one transaction.
 * Returns the gwei booked.
 */
async function bookClaim(engine: Engine, t: TokenRow, res: ClaimResult, settles: (p: PendingClaim) => boolean, late: boolean): Promise<number> {
  const unburned = res.tokensUnburned && res.tokensUnburned.amount > 0n ? res.tokensUnburned : null;
  // Launchpad LP fees can also pay out in the token itself; those are burned by the claim.
  const memecoin = res.tokensBurned?.amount ?? unburned?.amount ?? 0n;
  let memecoinUsd = 0;
  const memecoinUnits = rawToUnits(memecoin, t.decimals);
  if (memecoin > 0n) {
    const market = await engine.market.tokenMarket(t.address).catch(() => null);
    memecoinUsd = market?.priceUsd ? memecoinUnits * market.priceUsd : 0;
  }

  const at = engine.clock();
  return engine.db.transaction(() => {
    clearPendingClaims(engine, settles);
    // Memecoin fees are burned on-chain (or held for a retried burn) even when no ETH comes back; gas is spent either way.
    if (res.amountWei <= 0n && res.gasWei <= 0n && !res.tokensBurned && !unburned) return 0;
    const booked = engine.ledger.recordClaim({ token: t.address, strategy: t.strategy, amountWei: res.amountWei, gasWei: res.gasWei, tx: res.tx, at });
    if (!booked && (res.amountWei > 0n || res.gasWei > 0n)) return 0; // this claim tx was already booked
    if (res.tokensBurned) {
      insertBurn(engine.db, {
        at,
        token: t.address,
        target: t.address,
        kind: 'claim',
        amountInGwei: 0,
        amountOut: res.tokensBurned.amount,
        decimals: t.decimals,
        usdMicro: usdToMicro(memecoinUsd),
        refId: res.tx.hash,
        swapTx: null,
        burnTx: res.tokensBurned.tx,
      });
    }
    if (unburned) {
      holdForBurn(engine, {
        refId: res.tx.hash,
        kind: 'claim',
        target: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        amountOut: unburned.amount.toString(),
        swapTx: null,
        at,
        legs: [{ token: t.address, gwei: 0, out: unburned.amount.toString(), usdMicro: usdToMicro(memecoinUsd) }],
        burnTx: unburned.burnUnconfirmed ? { ...unburned.burnUnconfirmed, at } : null,
      });
    }
    const eth = booked ? gweiToEth(booked.totalGwei) : 0;
    const units = memecoinUnits.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const memecoinNote = res.tokensBurned ? `${units} $${t.symbol} burned` : unburned ? `${units} $${t.symbol} held for a retried burn` : null;
    const lateNote = late ? ' (tx confirmed after its receipt timed out)' : '';
    activity(engine, {
      kind: 'claim',
      token: { address: t.address, symbol: t.symbol },
      title:
        eth > 0
          ? `Claimed ${eth.toFixed(5)} ETH in creator fees for $${t.symbol}${memecoinNote ? `; ${memecoinNote}` : ''}${lateNote}`
          : memecoinNote
            ? `Claimed creator fees for $${t.symbol}: ${memecoinNote}${lateNote}`
            : `Fee claim for $${t.symbol} paid gas but received nothing yet${lateNote}`,
      amountEth: eth,
      ...(res.tokensBurned ? { tokensBurned: memecoinUnits } : {}),
      txs: res.tokensBurned ? [res.tx, res.tokensBurned.tx] : [res.tx],
    });
    return booked?.totalGwei ?? 0;
  });
}

function pendingClaims(engine: Engine): PendingClaim[] {
  return kvGet<PendingClaim[]>(engine.db, PENDING_CLAIMS_KEY) ?? [];
}

function clearPendingClaims(engine: Engine, match: (p: PendingClaim) => boolean): void {
  const all = pendingClaims(engine);
  const keep = all.filter((p) => !match(p));
  if (keep.length !== all.length) kvSet(engine.db, PENDING_CLAIMS_KEY, keep);
}

/** Settles claim calls whose outcome never came back. `waiting` lists those still unresolved. */
async function resolvePendingClaims(engine: Engine, failures: string[]): Promise<{ gwei: number; booked: number; waiting: string[] }> {
  const out = { gwei: 0, booked: 0, waiting: [] as string[] };
  for (const p of pendingClaims(engine)) {
    const t = getToken(engine.db, p.token);
    const label = `${t ? `$${t.symbol}` : p.token} claim tx ${p.hash}`;
    const launchpad = engine.io.launchpads[p.launchpad];
    try {
      if (!t || !launchpad.lookupClaim) throw new Error(t ? `${p.launchpad} cannot look up claim txs` : 'token not found');
      const res = await launchpad.lookupClaim(p.token, p);
      const isP = (q: PendingClaim) => q.hash === p.hash;
      if (res.status === 'pending' || (res.status === 'dropped' && engine.clock() - p.at < DROP_GRACE_MS)) {
        out.waiting.push(`${label} not mined yet`);
      } else if (res.status === 'dropped') {
        clearPendingClaims(engine, isP);
        log.warn('Fee claim tx was never mined; claims resume', { token: p.token, hash: p.hash });
      } else {
        const result: ClaimResult = {
          amountWei: res.ok ? res.amountWei : 0n,
          gasWei: res.gasWei,
          tx: res.tx,
          tokensBurned: null,
          tokensUnburned: res.ok && res.tokens > 0n ? { amount: res.tokens, burnUnconfirmed: null } : null,
        };
        out.gwei += await bookClaim(engine, t, result, isP, true);
        out.booked++;
        if (res.ok && res.nativeUnknown) {
          log.error('Late fee claim shares its block with other protocol-wallet txs; its native ETH payout is not booked', { token: p.token, hash: p.hash });
          activity(engine, {
            kind: 'risk',
            token: { address: t.address, symbol: t.symbol },
            title: `Fee claim ${p.hash} for $${t.symbol} confirmed late in a block with other protocol-wallet txs: only its WETH was booked; check the wallet for unbooked ETH`,
            txs: [res.tx],
          });
        }
      }
    } catch (err) {
      out.waiting.push(`${label} unresolved`);
      failures.push(`${label}: ${shortError(err)}`);
      log.warn('pending claim lookup failed', { token: p.token, hash: p.hash, error: errorMessage(err) });
    }
  }
  return out;
}
