import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listActivity } from '../activity.ts';
import { setKillSwitch } from '../engine.ts';
import { PriceGuardError } from '../integrations/index.ts';
import type { TxOutcome } from '../ports.ts';
import { burnTotals } from '../positions.ts';
import { address, createTestEngine, seedToken } from '../testing/fakes.ts';
import { MIN_SAMPLES, REFERENCE_SPAN_MS, rollingReference, runBuyback, SAMPLE_MAX_AGE_MS } from './buyback.ts';

const A = address(0xa);
const B = address(0xb);
const ETH = 10n ** 18n;
const GWEI = 10n ** 9n;
const OUT = 7n * 10n ** 20n;
const BUDGET = 250_000_000; // gwei: A's token buyback budget
const TRADING = 600_000_000; // gwei: A's trading ETH
const rhc = (c: string) => ({ chain: 'rhc' as const, hash: `0x${c.repeat(64)}` });

/** Token A with a 0.25 ETH buyback budget (1 ETH of balanced fees), wallet funded to match. */
function setup() {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, symbol: 'AAA' });
  t.engine.ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, tx: rhc('1'), at: 1 });
  t.world.balances.rhcEth = 1.01;
  t.world.dexOut.set(A, OUT);
  const swaps: bigint[] = [];
  const burns: bigint[] = [];
  return { ...t, swaps, burns };
}

const mined = (hash: string, over: Partial<Extract<TxOutcome, { status: 'mined' }>> = {}): TxOutcome => ({
  status: 'mined',
  ok: true,
  tx: { chain: 'rhc', hash },
  gasWei: 0n,
  valueWei: 0n,
  received: 0n,
  burned: 0n,
  ...over,
});

test('a swap whose burn fails is booked once; later runs retry only the burn', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => {
    s.swaps.push(amountInWei);
    return { amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: null, gasWei: 0n };
  };
  let burnFails = true;
  s.world.io.dex.burnHeld = async (_token, amount) => {
    if (burnFails) throw new Error('burn reverted');
    s.burns.push(amount);
    return { amount, tx: rhc('6'), gasWei: 0n };
  };

  await runBuyback(s.engine);
  assert.equal(s.swaps.length, 1);
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, 0, 'budget spent exactly once');
  assert.equal(s.engine.ledger.book(A).buyback_spent_eth, BUDGET);
  assert.equal(burnTotals(s.engine.db).byTarget.get(A), undefined, 'nothing counted as burned yet');

  await assert.rejects(runBuyback(s.engine), /pending burn: burn reverted/);
  assert.equal(s.swaps.length, 1, 'no second swap for the same budget');

  burnFails = false;
  await runBuyback(s.engine);
  assert.deepEqual(s.burns, [OUT]);
  assert.equal(burnTotals(s.engine.db).byTarget.get(A), OUT);
  await runBuyback(s.engine);
  assert.equal(s.burns.length, 1, 'a completed burn is not repeated');
});

test('buyback gas is booked against the token: its spent budget first, then its other ETH budgets', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => ({ amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: rhc('6'), gasWei: 3_000_000n * GWEI });
  await runBuyback(s.engine);
  const book = s.engine.ledger.book(A);
  assert.equal(book.buyback_spent_eth, BUDGET);
  assert.equal(book.token_buyback_eth, 0);
  assert.equal(book.gas_eth, 3_000_000);
  assert.equal(book.trading_eth, TRADING - 3_000_000, 'the emptied buyback budget could not pay, trading ETH did');
  assert.equal(book.gas_debt_eth, 0);
});

test('a swap whose outcome never came back freezes its budget until it is looked up, then is booked once', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async (_token, amountInWei, _bps, opts) => {
    s.swaps.push(amountInWei);
    opts?.onSwapBroadcast?.({ hash: rhc('5').hash, nonce: 7 });
    throw new Error('Uniswap V3 buyback: no receipt for 0x5…');
  };
  await assert.rejects(runBuyback(s.engine), /no receipt/);
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, BUDGET, 'nothing booked yet');

  let outcome: TxOutcome = { status: 'pending' };
  s.world.io.dex.lookupTx = async () => outcome;
  const summary = await runBuyback(s.engine);
  assert.equal(s.swaps.length, 1, 'no second swap while the first is unresolved');
  assert.match(summary, /still unresolved/);

  outcome = mined(rhc('5').hash, { valueWei: BigInt(BUDGET) * GWEI, received: OUT, gasWei: 1_000n * GWEI });
  s.world.io.dex.burnHeld = async (_token, amount) => {
    s.burns.push(amount);
    return { amount, tx: rhc('6'), gasWei: 0n };
  };
  await runBuyback(s.engine);
  const book = s.engine.ledger.book(A);
  assert.equal(book.buyback_spent_eth, BUDGET, 'the landed swap is booked');
  assert.equal(book.token_buyback_eth, 0);
  assert.equal(book.gas_eth, 1_000);
  assert.deepEqual(s.burns, [OUT], 'its tokens are burned in the same run');
  assert.equal(burnTotals(s.engine.db).byTarget.get(A), OUT);
  await runBuyback(s.engine);
  assert.equal(s.swaps.length, 1);
  assert.equal(s.burns.length, 1);
});

test('a reverted swap books only its gas; a dropped one frees its budget only after a grace period', async () => {
  for (const kind of ['reverted', 'dropped'] as const) {
    const s = setup();
    let first = true;
    s.world.io.dex.buyAndBurn = async (_token, amountInWei, _bps, opts) => {
      s.swaps.push(amountInWei);
      if (!first) return { amountInWei, amountOut: OUT, swapTx: rhc('8'), burnTx: rhc('9'), gasWei: 0n };
      first = false;
      opts?.onSwapBroadcast?.({ hash: rhc('5').hash, nonce: 7 });
      throw new Error('no receipt');
    };
    await assert.rejects(runBuyback(s.engine));
    s.world.io.dex.lookupTx = async () => (kind === 'reverted' ? mined(rhc('5').hash, { ok: false, gasWei: 2_000n * GWEI }) : { status: 'dropped' });
    if (kind === 'dropped') {
      await runBuyback(s.engine);
      assert.equal(s.swaps.length, 1, 'a fresh "dropped" may be a lagging replica: keep waiting');
      s.now.t += 16 * 60_000;
    }
    await runBuyback(s.engine);
    const book = s.engine.ledger.book(A);
    assert.equal(s.swaps.length, 2, `${kind}: the budget is spent by a new swap`);
    // The reverted swap's gas came out of the buyback budget it was spending; the retry spends the rest.
    assert.equal(book.buyback_spent_eth, kind === 'reverted' ? BUDGET - 2_000 : BUDGET, `${kind}: spent once`);
    assert.equal(book.gas_eth, kind === 'reverted' ? 2_000 : 0);
  }
});

test('an unconfirmed burn is looked up instead of burning again, and booked when it landed', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => ({
    amountInWei,
    amountOut: OUT,
    swapTx: rhc('5'),
    burnTx: null,
    gasWei: 0n,
    burnUnconfirmed: { hash: rhc('6').hash, nonce: 8 },
  });
  await runBuyback(s.engine);
  s.world.io.dex.burnHeld = async () => {
    throw new Error('must not burn again');
  };
  s.world.io.dex.lookupTx = async (tx) => mined(tx.hash, { burned: OUT, gasWei: 500n * GWEI });
  await runBuyback(s.engine);
  assert.equal(burnTotals(s.engine.db).byTarget.get(A), OUT);
  const row = s.engine.db.get<{ burn_hash: string }>('SELECT burn_hash FROM burns WHERE target = ?', [A]);
  assert.equal(row?.burn_hash, rhc('6').hash);
  assert.equal(s.engine.ledger.book(A).gas_eth, 500);
});

test('a retried burn records what was actually burned, and a wallet holding none drops the burn instead of wedging', async () => {
  for (const held of [OUT / 2n, 0n]) {
    const s = setup();
    s.world.io.dex.buyAndBurn = async (_token, amountInWei) => ({ amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: null, gasWei: 0n });
    s.world.io.dex.burnHeld = async () => {
      throw new Error('rpc down');
    };
    await runBuyback(s.engine).catch(() => undefined);
    s.world.io.dex.burnHeld = async (_token, amount) => {
      const burned = held < amount ? held : amount;
      return burned > 0n ? { amount: burned, tx: rhc('6'), gasWei: 0n } : { amount: 0n, tx: null, gasWei: 0n };
    };
    await runBuyback(s.engine).catch(() => undefined);
    assert.equal(burnTotals(s.engine.db).byTarget.get(A), held === 0n ? undefined : held, 'only the burned amount is recorded');
    if (held === 0n) assert.ok(listActivity(s.engine.db, { limit: 10 }).some((e) => e.kind === 'risk' && /no longer holds/.test(e.title)));
    let called = false;
    s.world.io.dex.burnHeld = async () => {
      called = true;
      throw new Error('must not retry');
    };
    await runBuyback(s.engine);
    assert.equal(called, false, 'the pending burn is gone; the worker runs clean');
  }
});

test('the kill switch blocks swaps but still finishes pending burns', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => ({ amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: null, gasWei: 0n });
  s.world.io.dex.burnHeld = async () => {
    throw new Error('rpc down');
  };
  // Leaves a pending burn: the swap landed, its burn failed.
  await runBuyback(s.engine).catch(() => undefined);

  setKillSwitch(s.engine, true, 'test');
  s.engine.ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, tx: rhc('2'), at: 2 });
  s.world.balances.rhcEth = 2;
  let swapped = false;
  s.world.io.dex.buyAndBurn = async () => {
    swapped = true;
    throw new Error('must not swap');
  };
  s.world.io.dex.burnHeld = async (_token, amount) => {
    s.burns.push(amount);
    return { amount, tx: rhc('6'), gasWei: 0n };
  };
  const summary = await runBuyback(s.engine);
  assert.equal(swapped, false);
  assert.deepEqual(s.burns, [OUT]);
  assert.match(summary, /kill switch on/);
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, BUDGET, 'new budget left untouched');
});

test('a price-guard refusal skips without failing the run or spending the budget', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async () => {
    throw new PriceGuardError('twap-deviation', 'pays 900 bps over TWAP');
  };
  const summary = await runBuyback(s.engine);
  assert.match(summary, /skipped: \$AAA: pays 900 bps over TWAP/);
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, BUDGET);
});

test('a refusal that already mined a preparatory tx books its gas', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async () => {
    const err = new PriceGuardError('no-twap', 'no TWAP yet');
    err.spent = { gasWei: 400n * GWEI, tx: rhc('4') };
    throw err;
  };
  await runBuyback(s.engine);
  await runBuyback(s.engine);
  const book = s.engine.ledger.book(A);
  assert.equal(book.gas_eth, 400, 'booked once');
  assert.equal(book.token_buyback_eth, BUDGET - 400);
});

test("a wallet shortfall never spends another token's reserved ETH", async () => {
  const s = setup();
  seedToken(s.engine, { address: B, symbol: 'BBB' });
  s.engine.ledger.recordClaim({ token: B, strategy: 'balanced', amountWei: ETH, tx: rhc('3'), at: 1 });
  // Reserved on RHC: 2 ETH of claimed fees. The wallet holds only 1.26 ETH (gas reserve 0.01).
  s.world.balances.rhcEth = 1.26;
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => {
    s.swaps.push(amountInWei);
    return { amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: rhc('6'), gasWei: 0n };
  };
  const summary = await runBuyback(s.engine);
  assert.equal(s.swaps.length, 0);
  assert.match(summary, /\$AAA waiting for RHC balance/);
});

test('a V4 buyback waits for spot samples spanning the TWAP window, then buys against their median', async () => {
  const s = setup();
  const spots = [1000, 5000, 990, 1010]; // one manipulated sample among honest ones
  let run = 0;
  s.world.io.dex.spotPrice = async () => spots[run]!;
  const references: (number | undefined)[] = [];
  s.world.io.dex.buyAndBurn = async (_token, amountInWei, _bps, opts) => {
    references.push(opts?.referencePrice);
    return { amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: rhc('6'), gasWei: 0n };
  };
  for (; run < MIN_SAMPLES; run++) {
    const summary = await runBuyback(s.engine);
    assert.match(summary, /collecting V4 price history/);
    s.now.t += 600_000;
  }
  assert.deepEqual(references, [], 'no buy before the history spans the window');
  await runBuyback(s.engine);
  assert.deepEqual(references, [1000], 'median of the earlier samples; the current spot never counts');
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, 0);
});

test('the rolling reference needs enough samples spanning the window, ignores stale and current ones, and takes the median', () => {
  const now = 10_000_000;
  const at = (agoMs: number, price: number) => ({ at: now - agoMs, price });
  assert.equal(rollingReference([at(1_200_000, 1), at(600_000, 2)], now), null, 'too few');
  assert.equal(rollingReference([at(REFERENCE_SPAN_MS - 1, 1), at(300_000, 2), at(1, 3)], now), null, 'not spanning the window');
  assert.equal(rollingReference([at(SAMPLE_MAX_AGE_MS + 1, 1), at(1_200_000, 2), at(600_000, 3)], now), null, 'stale samples do not count');
  assert.equal(rollingReference([at(1_200_000, 2), at(600_000, 3), at(0, 1)], now), null, 'the current sample does not count');
  assert.equal(rollingReference([at(1_800_000, 10), at(1_200_000, 1), at(600_000, 2)], now), 2);
  assert.equal(rollingReference([at(1_800_000, 4), at(1_200_000, 1), at(900_000, 2), at(600_000, 3)], now), 2.5);
});

test('a recovered swap whose budget shrank meanwhile is booked clamped, with the shortfall surfaced', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async (_token, amountInWei, _bps, opts) => {
    s.swaps.push(amountInWei);
    opts?.onSwapBroadcast?.({ hash: rhc('5').hash, nonce: 7 });
    throw new Error('no receipt');
  };
  await assert.rejects(runBuyback(s.engine), /no receipt/);
  // Another worker's gas draws on the buyback budget while the swap is unresolved.
  s.engine.ledger.recordGas({ refId: 'other', legs: [{ token: A, gwei: 1 }], gasWei: 50_000_000n * GWEI, prefer: 'token_buyback_eth', tx: null, at: 2 });
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, BUDGET - 50_000_000);

  s.world.io.dex.lookupTx = async () => mined(rhc('5').hash, { valueWei: BigInt(BUDGET) * GWEI, received: OUT, gasWei: 1_000n * GWEI });
  s.world.io.dex.burnHeld = async (_token, amount) => ({ amount, tx: rhc('6'), gasWei: 0n });
  await runBuyback(s.engine);
  const book = s.engine.ledger.book(A);
  assert.equal(book.buyback_spent_eth, BUDGET - 50_000_000, 'debited only what was left');
  assert.equal(book.token_buyback_eth, 0);
  assert.equal(book.gas_eth, 50_000_000 + 1_000);
  assert.equal(burnTotals(s.engine.db).byTarget.get(A), OUT, 'the swap is resolved and its tokens burned');
  assert.ok(listActivity(s.engine.db, { limit: 50 }).some((a) => a.kind === 'risk' && /shortfall/.test(a.title)));
  await runBuyback(s.engine);
  assert.equal(s.swaps.length, 1);
});

test('gas debt does not hold every buyback hostage: the wallet backs budgets minus the debt', async () => {
  const s = setup();
  seedToken(s.engine, { address: B, symbol: 'BBB' });
  // B has no budgets: its gas becomes debt, paid from the wallet's float.
  s.engine.ledger.recordGas({ refId: 'g', legs: [{ token: B, gwei: 1 }], gasWei: 100_000_000n * GWEI, prefer: 'trading_eth', tx: null, at: 2 });
  assert.equal(s.engine.ledger.book(B).gas_debt_eth, 100_000_000);
  s.world.balances.rhcEth = 0.91;
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => {
    s.swaps.push(amountInWei);
    return { amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: rhc('6'), gasWei: 0n };
  };
  const summary = await runBuyback(s.engine);
  assert.doesNotMatch(summary, /waiting for RHC balance/);
  assert.equal(s.swaps.length, 1);
});
