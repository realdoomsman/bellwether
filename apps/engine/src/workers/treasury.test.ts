import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listActivity } from '../activity.ts';
import { kvGet } from '../db.ts';
import { setKillSwitch } from '../engine.ts';
import type { BridgeDepositStatus } from '../ports.ts';
import { address, createTestEngine, seedToken } from '../testing/fakes.ts';
import { BRIDGE_DROP_GRACE_MS, BRIDGE_STUCK_ALERT_MS, BRIDGE_UNKNOWN_GRACE_MS, PENDING_BRIDGE_KEY, runTreasury, type PendingBridge } from './treasury.ts';

const A = address(0xa);
const REQUEST = `0x${'12'.repeat(32)}`;
const DEPOSIT = `0x${'d0'.repeat(32)}`;

/** How the fake deposit ends: `ok` returns, `timeout` throws after broadcast, `pre-broadcast` throws after `prepared`. */
type SendOutcome = 'ok' | 'timeout' | 'pre-broadcast';

function withTradingEth() {
  const t = createTestEngine({ BRIDGE_MIN_ETH: '0.01' });
  seedToken(t.engine, { address: A });
  t.engine.ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: 10n ** 18n, tx: { chain: 'rhc', hash: '0xc1' }, at: t.now.t });
  t.world.balances = { ...t.world.balances, rhcEth: 2 };
  const calls = { bridge: 0, topUp: 0, status: [] as { requestId: string; hash: string | null; nonce?: number | null }[] };
  const ctl = { outcome: 'ok' as SendOutcome, status: { state: 'unknown' } as BridgeDepositStatus, gasWei: 0n };
  t.world.io.bridge.ethToUsdc = async (amountWei, _max, _min, hooks) => {
    calls.bridge++;
    const expectedUsdc = (Number(amountWei) / 1e18) * t.world.ethUsd;
    hooks?.prepared?.({ requestId: REQUEST, expectedUsdc });
    if (ctl.outcome === 'pre-broadcast') throw new Error('Relay bridge: simulation reverted');
    const tx = { chain: 'rhc' as const, hash: DEPOSIT };
    hooks?.broadcast?.(tx, 5);
    if (ctl.outcome === 'timeout') throw new Error(`Relay bridge: no receipt for ${DEPOSIT}`);
    return { expectedUsdc, tx, gasWei: ctl.gasWei };
  };
  t.world.io.bridge.depositStatus = async (d) => {
    calls.status.push(d);
    return ctl.status;
  };
  t.world.io.venues[0]!.topUpMargin = async () => {
    calls.topUp++;
    return { movedUsd: 0, txs: [] };
  };
  const intent = () => kvGet<PendingBridge>(t.engine.db, PENDING_BRIDGE_KEY);
  const books = () => t.engine.ledger.books().get(A)!;
  return { t, calls, ctl, intent, books };
}

test('the kill switch halts bridging and margin top-ups', async () => {
  const { t, calls } = withTradingEth();
  setKillSwitch(t.engine, true, 'test');
  assert.match(await runTreasury(t.engine), /kill switch on/);
  assert.equal(calls.bridge + calls.topUp, 0);

  setKillSwitch(t.engine, false, 'test');
  await runTreasury(t.engine);
  assert.deepEqual([calls.bridge, calls.topUp], [1, 1]);
});

test('a bridge quote below the engine-priced floor is skipped even when its self-reported impact is small', async () => {
  const { t, calls } = withTradingEth();
  t.world.io.bridge.quote = async (amountWei) => ({ expectedUsdc: (Number(amountWei) / 1e18) * t.world.ethUsd * 0.5, impactPct: 0.001 });
  assert.match(await runTreasury(t.engine), /below the \$[\d.]+ floor/);
  assert.equal(calls.bridge, 0);
});

test('a non-numeric quote impact is not mistaken for a small one', async () => {
  const { t, calls } = withTradingEth();
  t.world.io.bridge.quote = async (amountWei) => ({ expectedUsdc: (Number(amountWei) / 1e18) * t.world.ethUsd, impactPct: Number.NaN });
  assert.match(await runTreasury(t.engine), /bridge skipped: impact/);
  assert.equal(calls.bridge, 0);
});

test('a completed bridge books the conversion and leaves no intent', async () => {
  const { t, intent, books } = withTradingEth();
  const before = books().trading_eth;
  assert.match(await runTreasury(t.engine), /bridged/);
  assert.equal(intent(), null);
  assert.ok(books().trading_eth < before);
  assert.ok(books().trading_usd > 0);
});

test('a deposit whose receipt timed out is booked once it is found on-chain, never sent twice', async () => {
  const { t, calls, ctl, intent, books } = withTradingEth();
  const before = books();
  ctl.outcome = 'timeout';
  await assert.rejects(runTreasury(t.engine), /no receipt/);
  assert.equal(calls.bridge, 1);
  const pending = intent()!;
  assert.equal(pending.requestId, REQUEST);
  assert.equal(pending.hash, DEPOSIT);
  assert.deepEqual(books(), before, 'nothing is booked before the deposit is confirmed');

  // Still in flight: the next run waits instead of sending another deposit.
  ctl.outcome = 'ok';
  ctl.status = { state: 'pending' };
  assert.match(await runTreasury(t.engine), /unconfirmed: waiting/);
  assert.equal(calls.bridge, 1);
  assert.deepEqual(calls.status.at(-1), { requestId: REQUEST, hash: DEPOSIT, nonce: 5 });

  ctl.status = { state: 'landed', tx: { chain: 'rhc', hash: DEPOSIT }, gasWei: 0n };
  assert.match(await runTreasury(t.engine), /confirmed: booked/);
  assert.equal(intent(), null);
  assert.equal(books().trading_eth, before.trading_eth - pending.amountGwei);
  assert.ok(Math.abs(books().trading_usd - before.trading_usd - Math.round(pending.expectedUsdc * 1e6)) <= 1);
  // The recovered run does not bridge again in the same pass: the budget it booked is gone.
  assert.equal(calls.bridge, 1);
});

test('a reverted deposit releases its budget for a new bridge without booking a conversion', async () => {
  const { t, calls, ctl, intent, books } = withTradingEth();
  const before = books().trading_eth;
  ctl.outcome = 'timeout';
  await assert.rejects(runTreasury(t.engine));
  ctl.outcome = 'ok';
  ctl.status = { state: 'reverted', tx: { chain: 'rhc', hash: DEPOSIT }, gasWei: 0n };
  const summary = await runTreasury(t.engine);
  assert.match(summary, /reverted: .* stays in the trading budget/);
  assert.match(summary, /bridged/, 'the released budget is bridged again in the same run');
  assert.equal(calls.bridge, 2);
  assert.equal(intent(), null);
  assert.ok(books().trading_eth < before);
});

test('a deposit that failed before broadcast is looked up by request id and released only after the grace period', async () => {
  const { t, calls, ctl, intent } = withTradingEth();
  ctl.outcome = 'pre-broadcast';
  await assert.rejects(runTreasury(t.engine), /simulation reverted/);
  assert.equal(intent()!.hash, null);

  ctl.outcome = 'ok';
  ctl.status = { state: 'unknown' };
  t.now.t += BRIDGE_UNKNOWN_GRACE_MS - 1;
  assert.match(await runTreasury(t.engine), /not seen yet/);
  assert.deepEqual(calls.status.at(-1), { requestId: REQUEST, hash: null, nonce: null });
  assert.equal(calls.bridge, 1);

  t.now.t += 1;
  assert.match(await runTreasury(t.engine), /released/);
  assert.equal(calls.bridge, 2);
  assert.equal(intent(), null);
});

test('an unconfirmed deposit is still settled while the kill switch is on', async () => {
  const { t, calls, ctl, intent, books } = withTradingEth();
  const before = books().trading_eth;
  ctl.outcome = 'timeout';
  await assert.rejects(runTreasury(t.engine));
  setKillSwitch(t.engine, true, 'test');
  ctl.status = { state: 'landed', tx: { chain: 'rhc', hash: DEPOSIT }, gasWei: 0n };
  assert.match(await runTreasury(t.engine), /confirmed: booked.*kill switch on/);
  assert.equal(intent(), null);
  assert.ok(books().trading_eth < before);
  assert.equal(calls.bridge, 1);
});

test('profit is not crossed against trading ETH that may already be in flight', async () => {
  const { t, ctl, intent } = withTradingEth();
  ctl.outcome = 'timeout';
  await assert.rejects(runTreasury(t.engine));
  ctl.status = { state: 'pending' };
  let crossed = 0;
  const real = t.engine.ledger.crossProfit.bind(t.engine.ledger);
  t.engine.ledger.crossProfit = (p) => {
    crossed++;
    return real(p);
  };
  await runTreasury(t.engine);
  assert.equal(crossed, 0);
  assert.notEqual(intent(), null);
});

const risks = (t: ReturnType<typeof withTradingEth>['t']) => listActivity(t.engine.db, { limit: 100 }).filter((a) => a.kind === 'risk');

test('a broadcast deposit dropped from the chain is released after the grace period, booking nothing', async () => {
  const { t, calls, ctl, intent, books } = withTradingEth();
  ctl.outcome = 'timeout';
  await assert.rejects(runTreasury(t.engine));
  const before = books();
  ctl.outcome = 'ok';
  ctl.status = { state: 'dropped' };
  t.now.t += BRIDGE_DROP_GRACE_MS - 1;
  assert.match(await runTreasury(t.engine), /unconfirmed: waiting/);
  assert.equal(calls.bridge, 1);
  assert.deepEqual(books(), before);

  t.now.t += 1;
  const summary = await runTreasury(t.engine);
  assert.match(summary, /dropped: .* stays in the trading budget/);
  assert.match(summary, /bridged/, 'the released budget is bridged again in the same run');
  assert.equal(calls.bridge, 2);
  assert.equal(intent(), null);
  assert.equal(risks(t).length, 1);
});

test('a deposit unsettled for hours is raised to the operator once and keeps blocking new deposits', async () => {
  const { t, calls, ctl, intent } = withTradingEth();
  ctl.outcome = 'timeout';
  await assert.rejects(runTreasury(t.engine));
  ctl.outcome = 'ok';
  ctl.status = { state: 'pending' };
  t.now.t += BRIDGE_STUCK_ALERT_MS - 1;
  await runTreasury(t.engine);
  assert.equal(risks(t).length, 0);
  t.now.t += 1;
  await runTreasury(t.engine);
  await runTreasury(t.engine);
  assert.equal(risks(t).length, 1, 'alerted once');
  assert.match(risks(t)[0]!.title, /still unsettled/);
  assert.notEqual(intent(), null);
  assert.equal(calls.bridge, 1);
});

test('bridge gas is paid by the bridged trading ETH, not the token buyback budget', async () => {
  const { t, ctl, books } = withTradingEth();
  const before = books();
  ctl.gasWei = 2_000_000n * 10n ** 9n;
  assert.match(await runTreasury(t.engine), /bridged/);
  const after = books();
  assert.equal(after.token_buyback_eth, before.token_buyback_eth);
  assert.equal(after.gas_eth - before.gas_eth, 2_000_000);
  assert.equal(after.trading_eth, 0);
  assert.equal(after.gas_debt_eth, 0);
});
