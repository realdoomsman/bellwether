import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setKillSwitch } from '../engine.ts';
import { address, createTestEngine, seedToken } from '../testing/fakes.ts';
import { runTreasury } from './treasury.ts';

const A = address(0xa);

function withTradingEth() {
  const t = createTestEngine({ BRIDGE_MIN_ETH: '0.01' });
  seedToken(t.engine, { address: A });
  t.engine.ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: 10n ** 18n, tx: { chain: 'rhc', hash: '0xc1' }, at: t.now.t });
  t.world.balances = { ...t.world.balances, rhcEth: 2 };
  const calls = { bridge: 0, topUp: 0 };
  t.world.io.bridge.ethToUsdc = async (amountWei) => {
    calls.bridge++;
    return { expectedUsdc: (Number(amountWei) / 1e18) * t.world.ethUsd, tx: { chain: 'rhc', hash: '0xb1' } };
  };
  t.world.io.venues[0]!.topUpMargin = async () => {
    calls.topUp++;
    return { movedUsd: 0, txs: [] };
  };
  return { t, calls };
}

test('the kill switch halts bridging and margin top-ups', async () => {
  const { t, calls } = withTradingEth();
  setKillSwitch(t.engine, true, 'test');
  assert.match(await runTreasury(t.engine), /kill switch on/);
  assert.deepEqual(calls, { bridge: 0, topUp: 0 });

  setKillSwitch(t.engine, false, 'test');
  await runTreasury(t.engine);
  assert.deepEqual(calls, { bridge: 1, topUp: 1 });
});

test('a bridge quote below the engine-priced floor is skipped even when its self-reported impact is small', async () => {
  const { t, calls } = withTradingEth();
  t.world.io.bridge.quote = async (amountWei) => ({ expectedUsdc: (Number(amountWei) / 1e18) * t.world.ethUsd * 0.5, impactPct: 0.001 });
  assert.match(await runTreasury(t.engine), /below the \$[\d.]+ floor/);
  assert.equal(calls.bridge, 0);
});
