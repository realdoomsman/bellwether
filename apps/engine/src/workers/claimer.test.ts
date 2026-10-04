import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listActivity } from '../activity.ts';
import { UnconfirmedTxError } from '../integrations/tx.ts';
import { burnTotals } from '../positions.ts';
import type { ClaimTxOutcome } from '../ports.ts';
import { address, createTestEngine, seedToken } from '../testing/fakes.ts';
import { runBuyback } from './buyback.ts';
import { runClaimer } from './claimer.ts';

const A = address(0xa);
const GWEI = 10n ** 9n;
const rhc = (c: string) => ({ chain: 'rhc' as const, hash: `0x${c.repeat(64)}` as const });

test('a claim that pays no ETH but burns token fees still records the burn', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  t.world.claimable.set(A, 10n ** 16n);
  // Someone else collected the ETH between preview and send; the launchpad still burned the token-side fees.
  t.world.io.launchpads.pons.claim = async () => ({ amountWei: 0n, gasWei: 0n, tx: rhc('c'), tokensBurned: { amount: 5n * 10n ** 18n, tx: rhc('b') } });

  await runClaimer(t.engine);

  assert.equal(burnTotals(t.engine.db).byTarget.get(A), 5n * 10n ** 18n);
  assert.equal(t.engine.ledger.book(A).fees_eth, 0);
  const [claim] = listActivity(t.engine.db, { limit: 5, token: A }).filter((e) => e.kind === 'claim');
  assert.equal(claim?.tokensBurned, 5);
});

test('an escrow holding only memecoin is claimed and burned; the ETH minimum gates only the ETH leg', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  const pons = t.world.io.launchpads.pons;
  let preview = { wei: 0n, tokens: 7n * 10n ** 18n };
  let claims = 0;
  pons.claimablePreview = async () => preview;
  pons.claimable = async () => preview.wei;
  pons.claim = async () => {
    claims++;
    return { amountWei: preview.wei, gasWei: 0n, tx: rhc(String(claims)), tokensBurned: { amount: preview.tokens, tx: { chain: 'rhc', hash: `0x${'d'.repeat(63)}${claims}` } } };
  };

  await runClaimer(t.engine);
  assert.equal(claims, 1, 'token-only claim runs');
  assert.equal(burnTotals(t.engine.db).byTarget.get(A), 7n * 10n ** 18n);

  // Dust ETH below claimMinEth and no memecoin: skipped, as before.
  preview = { wei: 1n, tokens: 0n };
  await runClaimer(t.engine);
  assert.equal(claims, 1, 'ETH below the minimum alone does not claim');

  // Dust ETH plus memecoin: the memecoin leg alone justifies the claim.
  preview = { wei: 1n, tokens: 2n * 10n ** 18n };
  await runClaimer(t.engine);
  assert.equal(claims, 2);
});

test('the claim pays its own gas before the fee split, so the budgets match what the wallet received', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, strategy: 'balanced' });
  t.world.claimable.set(A, 10n ** 18n);
  t.world.io.launchpads.pons.claim = async () => ({ amountWei: 10n ** 18n, gasWei: 1_000_000n * GWEI + 1n, tx: rhc('c'), tokensBurned: null });

  await runClaimer(t.engine);
  const book = t.engine.ledger.book(A);
  assert.equal(book.fees_eth, 1_000_000_000, 'fees claimed stay gross');
  assert.equal(book.gas_eth, 1_000_001, 'gas rounds up to the next gwei');
  assert.equal(book.trading_eth + book.token_buyback_eth + book.protocol_buyback_eth, 1_000_000_000 - 1_000_001);
});

test('memecoin a claim could not burn is held as a pending burn and burned by the next buyback run', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, symbol: 'AAA' });
  t.world.claimable.set(A, 10n ** 16n);
  const amount = 3n * 10n ** 18n;
  t.world.io.launchpads.pons.claim = async () => ({
    amountWei: 10n ** 16n,
    gasWei: 0n,
    tx: rhc('c'),
    tokensBurned: null,
    tokensUnburned: { amount, burnUnconfirmed: null },
  });
  await runClaimer(t.engine);
  assert.equal(burnTotals(t.engine.db).byTarget.get(A), undefined, 'not burned yet');
  t.world.dexOut.set(A, null); // no pool: the buyback run only burns what the claim held

  const burned: bigint[] = [];
  t.world.io.dex.burnHeld = async (_token, want) => {
    burned.push(want);
    return { amount: want, tx: rhc('b'), gasWei: 0n };
  };
  await runBuyback(t.engine);
  assert.deepEqual(burned, [amount]);
  assert.equal(burnTotals(t.engine.db).byTarget.get(A), amount);
  const row = t.engine.db.get<{ kind: string; ref_id: string; swap_hash: string | null }>('SELECT kind, ref_id, swap_hash FROM burns WHERE target = ?', [A]);
  assert.deepEqual({ ...row }, { kind: 'claim', ref_id: rhc('c').hash, swap_hash: null });
  await runBuyback(t.engine);
  assert.equal(burned.length, 1, 'burned once');
});

test('a claim that only spent gas books it as gas the float advanced, repaid by the next claim', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, strategy: 'balanced' });
  const pons = t.world.io.launchpads.pons;
  pons.claimablePreview = async () => ({ wei: 10n ** 18n, tokens: 0n });
  // The sweep landed, the escrow claim then failed: only gas was spent.
  pons.claim = async () => ({ amountWei: 0n, gasWei: 2_000n * GWEI, tx: rhc('1'), tokensBurned: null });
  await runClaimer(t.engine);
  assert.equal(t.engine.ledger.book(A).gas_debt_eth, 2_000);

  pons.claim = async () => ({ amountWei: 10n ** 18n, gasWei: 0n, tx: rhc('2'), tokensBurned: null });
  await runClaimer(t.engine);
  const book = t.engine.ledger.book(A);
  assert.equal(book.gas_debt_eth, 0, 'repaid');
  assert.equal(book.trading_eth + book.token_buyback_eth + book.protocol_buyback_eth, 1_000_000_000 - 2_000);
});

test('a claim whose receipt timed out is booked once from its receipt when it lands; nothing is claimed meanwhile', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, symbol: 'AAA', strategy: 'balanced' });
  const pons = t.world.io.launchpads.pons;
  pons.claimablePreview = async () => ({ wei: 10n ** 18n, tokens: 0n });
  const hash = rhc('c').hash;
  let claims = 0;
  pons.claim = async (_token, onBroadcast) => {
    if (claims++ > 0) return null;
    onBroadcast?.({ hash, nonce: 7 });
    throw new UnconfirmedTxError(`Pons fee claim: no receipt for ${hash}`, hash, 7);
  };
  await assert.rejects(runClaimer(t.engine), /no receipt/);
  assert.equal(t.engine.ledger.book(A).fees_eth, 0);

  let outcome: ClaimTxOutcome = { status: 'pending' };
  pons.lookupClaim = async () => outcome;
  assert.match(await runClaimer(t.engine), /not mined yet; new claims wait/);
  assert.equal(claims, 1, 'no new claim while one is unresolved');

  const memecoin = 3n * 10n ** 18n;
  outcome = { status: 'mined', ok: true, tx: rhc('c'), gasWei: 1_000n * GWEI, amountWei: 10n ** 18n, tokens: memecoin, nativeUnknown: false };
  await runClaimer(t.engine);
  await runClaimer(t.engine);
  const book = t.engine.ledger.book(A);
  assert.equal(book.fees_eth, 1_000_000_000, 'booked once');
  assert.equal(book.gas_eth, 1_000);
  assert.equal(book.trading_eth + book.token_buyback_eth + book.protocol_buyback_eth, 1_000_000_000 - 1_000);
  assert.equal(claims, 3, 'claims resume once it is settled');

  // The memecoin it paid is burned by the buyback worker.
  t.world.dexOut.set(A, null);
  const burned: bigint[] = [];
  t.world.io.dex.burnHeld = async (_token, want) => {
    burned.push(want);
    return { amount: want, tx: rhc('b'), gasWei: 0n };
  };
  await runBuyback(t.engine);
  assert.deepEqual(burned, [memecoin]);
});

test('an unconfirmed claim tx that reverted books only its gas; a dropped one is cleared after the grace period', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, strategy: 'balanced' });
  const pons = t.world.io.launchpads.pons;
  pons.claimablePreview = async () => ({ wei: 10n ** 18n, tokens: 0n });
  let claims = 0;
  pons.claim = async (_token, onBroadcast) => {
    claims++;
    const hash = rhc(String(claims)).hash;
    onBroadcast?.({ hash, nonce: claims });
    throw new UnconfirmedTxError(`no receipt for ${hash}`, hash, claims);
  };
  await assert.rejects(runClaimer(t.engine));
  pons.lookupClaim = async (_token, tx) => ({ status: 'mined', ok: false, tx: { chain: 'rhc', hash: tx.hash }, gasWei: 2_000n * GWEI, amountWei: 0n, tokens: 0n, nativeUnknown: false });
  await assert.rejects(runClaimer(t.engine)); // settles claim 1 as reverted, then claim 2 times out too
  assert.equal(t.engine.ledger.book(A).gas_debt_eth, 2_000);
  assert.equal(t.engine.ledger.book(A).fees_eth, 0);

  pons.lookupClaim = async () => ({ status: 'dropped' });
  assert.match(await runClaimer(t.engine), /not mined yet/, 'a fresh "dropped" may be a lagging replica');
  assert.equal(claims, 2);
  t.now.t += 16 * 60_000;
  await assert.rejects(runClaimer(t.engine)); // cleared, so claim 3 is sent
  assert.equal(claims, 3);
  assert.equal(t.engine.ledger.book(A).gas_debt_eth, 2_000, 'a dropped tx books nothing');
});

test('a claim whose later call is unconfirmed books what landed now and that call separately when it lands', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, strategy: 'balanced' });
  const pons = t.world.io.launchpads.pons;
  pons.claimablePreview = async () => ({ wei: 10n ** 18n, tokens: 0n });
  let claims = 0;
  pons.claim = async (_token, onBroadcast) => {
    if (claims++ > 0) return null;
    onBroadcast?.({ hash: rhc('1').hash, nonce: 1 }); // the sweep landed
    onBroadcast?.({ hash: rhc('2').hash, nonce: 2 }); // the escrow claim timed out
    return { amountWei: 0n, gasWei: 1_000n * GWEI, tx: rhc('1'), tokensBurned: null, unconfirmed: { hash: rhc('2').hash, nonce: 2 } };
  };
  const looked: string[] = [];
  pons.lookupClaim = async (_token, tx) => {
    looked.push(tx.hash);
    return { status: 'mined', ok: true, tx: { chain: 'rhc', hash: tx.hash }, gasWei: 500n * GWEI, amountWei: 10n ** 18n, tokens: 0n, nativeUnknown: false };
  };
  await runClaimer(t.engine);
  assert.equal(t.engine.ledger.book(A).gas_debt_eth, 1_000);
  await runClaimer(t.engine);
  await runClaimer(t.engine);
  assert.deepEqual(looked, [rhc('2').hash], 'only the unconfirmed call is looked up, once');
  const book = t.engine.ledger.book(A);
  assert.equal(book.fees_eth, 1_000_000_000);
  assert.equal(book.gas_eth, 1_500);
  assert.equal(book.gas_debt_eth, 0, 'the late payout repaid the sweep gas');
});
