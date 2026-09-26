import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setKillSwitch } from '../engine.ts';
import { PriceGuardError } from '../integrations/index.ts';
import { burnTotals } from '../positions.ts';
import { address, createTestEngine, seedToken } from '../testing/fakes.ts';
import { runBuyback } from './buyback.ts';

const A = address(0xa);
const B = address(0xb);
const ETH = 10n ** 18n;
const OUT = 7n * 10n ** 20n;
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

test('a swap whose burn fails is booked once; later runs retry only the burn', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => {
    s.swaps.push(amountInWei);
    return { amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: null };
  };
  let burnFails = true;
  s.world.io.dex.burnHeld = async (_token, amount) => {
    if (burnFails) throw new Error('burn reverted');
    s.burns.push(amount);
    return rhc('6');
  };

  await runBuyback(s.engine);
  assert.equal(s.swaps.length, 1);
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, 0, 'budget spent exactly once');
  assert.equal(s.engine.ledger.book(A).buyback_spent_eth, 250_000_000);
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

test('the kill switch blocks swaps but still finishes pending burns', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => ({ amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: null });
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
    return rhc('6');
  };
  const summary = await runBuyback(s.engine);
  assert.equal(swapped, false);
  assert.deepEqual(s.burns, [OUT]);
  assert.match(summary, /kill switch on/);
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, 250_000_000, 'new budget left untouched');
});

test('a price-guard refusal skips without failing the run or spending the budget', async () => {
  const s = setup();
  s.world.io.dex.buyAndBurn = async () => {
    throw new PriceGuardError('twap-deviation', 'pays 900 bps over TWAP');
  };
  const summary = await runBuyback(s.engine);
  assert.match(summary, /skipped: \$AAA: pays 900 bps over TWAP/);
  assert.equal(s.engine.ledger.book(A).token_buyback_eth, 250_000_000);
});

test("a wallet shortfall never spends another token's reserved ETH", async () => {
  const s = setup();
  seedToken(s.engine, { address: B, symbol: 'BBB' });
  s.engine.ledger.recordClaim({ token: B, strategy: 'balanced', amountWei: ETH, tx: rhc('3'), at: 1 });
  // Reserved on RHC: 2 ETH of claimed fees. The wallet holds only 1.26 ETH (gas reserve 0.01).
  s.world.balances.rhcEth = 1.26;
  s.world.io.dex.buyAndBurn = async (_token, amountInWei) => {
    s.swaps.push(amountInWei);
    return { amountInWei, amountOut: OUT, swapTx: rhc('5'), burnTx: rhc('6') };
  };
  const summary = await runBuyback(s.engine);
  assert.equal(s.swaps.length, 0);
  assert.match(summary, /\$AAA waiting for RHC balance/);
});
