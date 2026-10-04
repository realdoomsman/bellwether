import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kvGet } from '../db.ts';
import type { BridgeDepositStatus } from '../ports.ts';
import { address, createTestEngine, fundUsd, seedToken, type TestEngine } from '../testing/fakes.ts';
import { gweiToEth } from '../units.ts';
import { IN_FLIGHT_BOUND_MS, RECONCILIATION_KEY, runReconciler, type ReconciliationSnapshot } from './reconciler.ts';
import { PENDING_BRIDGE_KEY, runTreasury, USDC_IN_FLIGHT_KEY, type PendingBridge } from './treasury.ts';

const A = address(0xa);
const B = address(0xb);
const GWEI = 10n ** 9n;
const ETH = 10n ** 18n;
const rhc = (c: string) => ({ chain: 'rhc' as const, hash: `0x${c.repeat(64)}` });

async function ethItem(t: TestEngine) {
  await runReconciler(t.engine);
  return kvGet<ReconciliationSnapshot>(t.engine.db, RECONCILIATION_KEY)!.items.find((i) => i.asset === 'ETH' && i.chain === 'rhc')!;
}

test('booked gas keeps the RHC ETH reconciliation exact, including gas the float advanced', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  seedToken(t.engine, { address: B });
  // 1 ETH claimed for 0.002 ETH of gas: the wallet gained 0.998 ETH.
  t.engine.ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, gasWei: 2_000_000n * GWEI, tx: rhc('1'), at: 1 });
  t.world.balances.rhcEth = 0.998;
  let item = await ethItem(t);
  assert.equal(item.expected, 0.998);
  assert.equal(item.ok, true);

  // B claims 1 ETH; A spends its buyback budget, then pays 0.8 ETH of gas its remaining 0.7485 ETH cannot cover.
  t.engine.ledger.recordClaim({ token: B, strategy: 'balanced', amountWei: ETH, tx: rhc('2'), at: 2 });
  t.engine.ledger.recordBuyback({ refId: 'b', kind: 'token', legs: [{ token: A, gwei: 249_500_000 }], tx: rhc('3'), at: 3 });
  t.engine.ledger.recordGas({ refId: 'g', legs: [{ token: A, gwei: 1 }], gasWei: 800_000_000n * GWEI, prefer: 'token_buyback_eth', tx: rhc('4'), at: 4 });
  assert.equal(t.engine.ledger.book(A).gas_debt_eth, 51_500_000);
  // The wallet: 0.998 + 1 - 0.2495 - 0.8.
  t.world.balances.rhcEth = 0.9485;
  item = await ethItem(t);
  assert.equal(item.expected, 0.9485, "B's budgets minus the gas the float advanced for A");
  assert.equal(item.ok, true);
});

async function reconcile(t: TestEngine) {
  await runReconciler(t.engine);
  const s = kvGet<ReconciliationSnapshot>(t.engine.db, RECONCILIATION_KEY)!;
  return {
    eth: s.items.find((i) => i.asset === 'ETH')!,
    usdc: s.items.find((i) => i.asset === 'USDC')!,
    inFlight: s.wallets.filter((w) => w.asset.includes('in flight')).map((w) => [w.asset, w.amount]),
    risks: t.engine.db.all<{ title: string }>(`SELECT title FROM activity WHERE kind = 'risk'`).map((r) => r.title),
  };
}

const DEPOSIT = `0x${'d0'.repeat(32)}`;

/** Token A with 1 ETH claimed and the RHC wallet holding exactly its budgets; Relay deposits end per `relay`. */
async function withBridgeableEth() {
  const t = createTestEngine({ BRIDGE_MIN_ETH: '0.01' });
  seedToken(t.engine, { address: A });
  t.engine.ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, tx: rhc('c'), at: t.now.t });
  t.world.balances.rhcEth = 5;
  t.world.balances.rhcEth = (await reconcile(t)).eth.expected;
  const relay = { timeout: false, status: { state: 'pending' } as BridgeDepositStatus };
  t.world.io.bridge.ethToUsdc = async (amountWei, _max, _min, hooks) => {
    const expectedUsdc = (Number(amountWei) / 1e18) * t.world.ethUsd;
    hooks?.prepared?.({ requestId: `0x${'12'.repeat(32)}`, expectedUsdc });
    hooks?.broadcast?.({ chain: 'rhc', hash: DEPOSIT });
    // The deposit leaves the wallet once broadcast.
    t.world.balances.rhcEth -= Number(amountWei) / 1e18;
    if (relay.timeout) throw new Error(`Relay bridge: no receipt for ${DEPOSIT}`);
    return { expectedUsdc, tx: { chain: 'rhc', hash: DEPOSIT }, gasWei: 0n };
  };
  t.world.io.bridge.depositStatus = async () => relay.status;
  return { t, relay };
}

test('an unconfirmed Relay deposit counts as ETH in flight until the bound, then shows as drift', async () => {
  const { t, relay } = await withBridgeableEth();
  relay.timeout = true;
  await assert.rejects(runTreasury(t.engine), /no receipt/);
  const eth = gweiToEth(kvGet<PendingBridge>(t.engine.db, PENDING_BRIDGE_KEY)!.amountGwei);

  let r = await reconcile(t);
  assert.equal(r.eth.ok, true);
  assert.deepEqual(r.inFlight, [['ETH (in flight: bridging to Arbitrum USDC)', eth]]);

  t.now.t += IN_FLIGHT_BOUND_MS;
  r = await reconcile(t);
  assert.equal(r.eth.ok, false);
  assert.ok(Math.abs(r.eth.drift + eth) < 1e-9);
  assert.deepEqual(r.inFlight, []);
  assert.equal(r.risks.filter((x) => x.startsWith('Reserve drift on rhc ETH')).length, 1);
});

test('USDC booked from a Relay deposit counts as in flight until Relay reports it delivered', async () => {
  const { t, relay } = await withBridgeableEth();
  await runTreasury(t.engine);
  const usd = t.engine.ledger.book(A).trading_usd / 1e6;
  assert.ok(usd > 0);

  let r = await reconcile(t);
  assert.deepEqual([r.eth.ok, r.usdc.ok], [true, true]);
  assert.deepEqual(r.inFlight, [['USDC (in flight: bridge to Arbitrum)', usd]]);

  // Delivered: the USDC is on Arbitrum and the in-flight line is gone.
  relay.status = { state: 'landed', tx: rhc('d0'), gasWei: 0n, filled: true };
  t.world.balances.arbitrumUsdc = usd;
  r = await reconcile(t);
  assert.equal(r.usdc.ok, true);
  assert.deepEqual(r.inFlight, []);
  assert.deepEqual(kvGet(t.engine.db, USDC_IN_FLIGHT_KEY), []);
});

test('USDC that never arrives is reported once the bound passes', async () => {
  const { t } = await withBridgeableEth();
  await runTreasury(t.engine);
  assert.equal((await reconcile(t)).usdc.ok, true);

  t.now.t += IN_FLIGHT_BOUND_MS;
  const r = await reconcile(t);
  assert.equal(r.usdc.ok, false);
  assert.deepEqual(r.inFlight, []);
  assert.ok(r.risks.some((x) => /bridged to Arbitrum has not arrived after 30 minutes/.test(x)));
  assert.ok(r.risks.some((x) => x.startsWith('Reserve drift on hyperliquid USDC')));
});

test('a margin deposit the venue has not credited counts as in flight until it is credited', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  fundUsd(t.engine, A, 100);
  t.world.balances.venueEquityUsd = 60;
  const venue = t.world.io.venues[0]!;
  const tx = { chain: 'arbitrum' as const, hash: `0x${'ab'.repeat(32)}` };
  venue.topUpMargin = async () => ({ movedUsd: 0, txs: [tx], uncredited: { usd: 40, tx } });
  let credited = false;
  venue.depositCredited = async (t2) => credited && t2.hash === tx.hash;
  await runTreasury(t.engine);

  let r = await reconcile(t);
  assert.equal(r.usdc.ok, true);
  assert.deepEqual(r.inFlight, [['USDC (in flight: deposit not credited yet)', 40]]);

  credited = true;
  t.world.balances.venueEquityUsd = 100;
  r = await reconcile(t);
  assert.equal(r.usdc.ok, true);
  assert.deepEqual(r.inFlight, []);
  assert.deepEqual(kvGet(t.engine.db, USDC_IN_FLIGHT_KEY), []);
});
