import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from '@stepup/shared';
import { setKillSwitch } from '../engine.ts';
import { openPositions, sharesOf } from '../positions.ts';
import { WEEKEND, address, createTestEngine, fundUsd, seedToken, trendCandles, type TestEngine } from '../testing/fakes.ts';
import { getToken } from '../tokens.ts';
import { runTrader } from './trader.ts';

const A = address(0xa);
const B = address(0xb);

function verdict(t: TestEngine, token: Address) {
  return getToken(t.engine.db, token)!.decision;
}

test('pools budgets per market: shares follow budgets, leverage follows the strictest cap', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, strategy: 'balanced', maxLeverage: 10 });
  seedToken(t.engine, { address: B, strategy: 'steady', maxLeverage: 3 });
  fundUsd(t.engine, A, 300);
  fundUsd(t.engine, B, 100);

  await runTrader(t.engine);

  assert.equal(t.world.opens.length, 1);
  const open = t.world.opens[0]!;
  assert.deepEqual({ symbol: open.symbol, side: open.side, leverage: open.leverage }, { symbol: 'AAPL', side: 'long', leverage: 3 });
  const [position] = openPositions(t.engine.db);
  const shares = new Map(sharesOf(t.engine.db, position!.id).map((s) => [s.token, s.share]));
  assert.ok(Math.abs(shares.get(A)! - 0.75) < 1e-6);
  assert.ok(Math.abs(shares.get(B)! - 0.25) < 1e-6);
  assert.ok(Math.abs(t.engine.ledger.book(A).deployed_usd / 1e6 - open.collateralUsd * 0.75) < 0.01);
  assert.ok(t.engine.ledger.book(A).trading_usd >= 0);
  assert.equal(verdict(t, A).verdict, 'in-position');
  assert.equal(verdict(t, B).verdict, 'in-position');

  // One position per market: the next run does not stack another entry.
  await runTrader(t.engine);
  assert.equal(t.world.opens.length, 1);
});

test('kill switch blocks new entries', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  fundUsd(t.engine, A, 300);
  setKillSwitch(t.engine, true, 'test');
  await runTrader(t.engine);
  assert.equal(t.world.opens.length, 0);
  assert.equal(verdict(t, A).verdict, 'kill-switch');
});

test('strategies only enter in their sessions', async () => {
  const t = createTestEngine({}, WEEKEND);
  seedToken(t.engine, { address: A, strategy: 'balanced', market: 'AAPL' });
  seedToken(t.engine, { address: B, strategy: 'degen', maxLeverage: 20, market: 'TSLA' });
  fundUsd(t.engine, A, 300);
  fundUsd(t.engine, B, 300);
  await runTrader(t.engine);
  assert.equal(verdict(t, A).verdict, 'waiting-session');
  assert.deepEqual(t.world.opens.map((o) => o.symbol), ['TSLA']);
});

test('daily loss limit halts a token until the next UTC day', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, strategy: 'balanced' });
  fundUsd(t.engine, A, 100);
  const at = t.now.t;
  t.engine.ledger.recordOpen({ positionId: 'old', tradeId: 'o', legs: [{ token: A, collateralMicro: 50_000_000, feeMicro: 0 }], tx: { chain: 'hyperliquid', hash: 'o' }, at });
  t.engine.ledger.recordExit({ positionId: 'old', tradeId: 'c', fraction: 1, pnlMicro: -30_000_000, shares: [{ token: A, share: 1 }], tx: null, at });

  await runTrader(t.engine);
  assert.equal(verdict(t, A).verdict, 'daily-loss-limit');
  assert.equal(t.world.opens.length, 0);

  t.now.t += 86_400_000;
  await runTrader(t.engine);
  assert.equal(t.world.opens.length, 1);
});

test('burn-only tokens never trade', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, strategy: 'burn', maxLeverage: 0 });
  await runTrader(t.engine);
  assert.equal(verdict(t, A).verdict, 'burn-only');
  assert.equal(t.world.opens.length, 0);
});

test('a weak signal waits and reports score against threshold', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, strategy: 'balanced' });
  fundUsd(t.engine, A, 300);
  t.world.candles['5m'] = trendCandles(120, { stepPct: -0.0005 });
  await runTrader(t.engine);
  const d = verdict(t, A);
  assert.equal(d.verdict, 'waiting-signal');
  assert.equal(d.signalThreshold, 35);
  assert.ok(d.signalScore! < 35);
  assert.equal(t.world.opens.length, 0);
});

test('pools below the minimum collateral wait', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  fundUsd(t.engine, A, 5);
  await runTrader(t.engine);
  assert.equal(verdict(t, A).verdict, 'below-minimum');
  assert.equal(t.world.opens.length, 0);
});
