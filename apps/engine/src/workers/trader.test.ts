import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from '@bellwether/shared';
import { listActivity } from '../activity.ts';
import { setKillSwitch } from '../engine.ts';
import { listTrades, openPositions, sharesOf } from '../positions.ts';
import { WEEKEND, address, createTestEngine, fundUsd, seedToken, trendCandles, type TestEngine } from '../testing/fakes.ts';
import { getToken } from '../tokens.ts';
import { runGuardian } from './guardian.ts';
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

test('a fill whose result never arrived is adopted once from the venue position, with the intended shares', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  seedToken(t.engine, { address: B });
  fundUsd(t.engine, A, 300);
  fundUsd(t.engine, B, 100);
  t.world.openErrorAfterFill = 'fills lookup timed out';

  await runTrader(t.engine);
  assert.equal(t.world.opens.length, 1);
  assert.equal(openPositions(t.engine.db).length, 0);
  assert.equal(t.engine.ledger.book(A).deployed_usd, 0);

  t.world.openErrorAfterFill = null;
  assert.match(await runTrader(t.engine), /adopted AAPL/);
  const intended = t.world.opens[0]!.collateralUsd * 1e6;
  const [position] = openPositions(t.engine.db);
  assert.equal(position!.market, 'AAPL');
  const shares = new Map(sharesOf(t.engine.db, position!.id).map((s) => [s.token, s.share]));
  assert.ok(Math.abs(shares.get(A)! - 0.75) < 1e-6);
  assert.ok(Math.abs(shares.get(B)! - 0.25) < 1e-6);
  const deployed = t.engine.ledger.book(A).deployed_usd + t.engine.ledger.book(B).deployed_usd;
  assert.ok(Math.abs(deployed - intended) <= 1);
  assert.equal(verdict(t, A).verdict, 'in-position');

  const books = t.engine.ledger.books();
  await runTrader(t.engine);
  await runGuardian(t.engine);
  assert.deepEqual(t.engine.ledger.books(), books);
  assert.equal(openPositions(t.engine.db).length, 1);
  assert.equal(listTrades(t.engine.db, { limit: 10 }).length, 1);
  assert.equal(t.world.opens.length, 1);
});

test('a partially filled open debits only the collateral that filled; the rest stays in the budgets', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  seedToken(t.engine, { address: B });
  fundUsd(t.engine, A, 300);
  fundUsd(t.engine, B, 100);
  t.world.fillRatio = 0.5;

  await runTrader(t.engine);

  const used = t.world.positions.get('AAPL')!.collateralUsd * 1e6;
  const [position] = openPositions(t.engine.db);
  assert.ok(Math.abs(position!.collateralMicro - used) <= 1);
  const deployed = t.engine.ledger.book(A).deployed_usd + t.engine.ledger.book(B).deployed_usd;
  assert.ok(Math.abs(deployed - used) <= 2, `deployed ${deployed} vs venue collateral ${used}`);
  const shares = new Map(sharesOf(t.engine.db, position!.id).map((s) => [s.token, s.share]));
  assert.ok(Math.abs(shares.get(A)! - 0.75) < 1e-6);
  assert.ok(t.engine.ledger.book(A).trading_usd > 300e6 / 2);
});

test('an open that errored before its position showed up keeps its intent: the market waits, then the late fill is adopted', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  fundUsd(t.engine, A, 300);
  const venue = t.engine.io.venues[0]!;
  const open = venue.open;
  venue.open = async (req) => {
    t.world.opens.push(req);
    throw new Error('Hyperliquid exchange order timed out');
  };

  await runTrader(t.engine);
  await runTrader(t.engine);
  assert.equal(t.world.opens.length, 1, 'no second entry while the first is unconfirmed');
  assert.match(verdict(t, A).message, /awaiting/);

  // The timed-out order landed after all.
  venue.open = open;
  await open(t.world.opens[0]!);
  assert.match(await runTrader(t.engine), /adopted AAPL/);
  assert.equal(openPositions(t.engine.db).length, 1);
  assert.equal(listActivity(t.engine.db, { limit: 50 }).filter((a) => a.kind === 'risk').length, 0);
});

test('an untracked venue position blocks its market, occupies the caps and is reported once', async () => {
  const t = createTestEngine({ MAX_TOTAL_DEPLOYED_USD: '1000' });
  seedToken(t.engine, { address: A, market: 'AAPL' });
  seedToken(t.engine, { address: B, market: 'TSLA' });
  fundUsd(t.engine, A, 300);
  fundUsd(t.engine, B, 300);
  t.world.positions.set('TSLA', {
    symbol: 'TSLA',
    side: 'long',
    sizeUsd: 3000,
    collateralUsd: 1000,
    entryPrice: 400,
    markPrice: 400,
    leverage: 3,
    unrealizedPnlUsd: 0,
    liquidationPrice: 280,
  });

  await runTrader(t.engine);
  await runTrader(t.engine);
  await runGuardian(t.engine);

  assert.equal(t.world.opens.length, 0);
  assert.match(verdict(t, B).message, /untracked TSLA/);
  assert.match(verdict(t, A).message, /deployment cap/);
  const risks = listActivity(t.engine.db, { limit: 50 }).filter((a) => a.kind === 'risk');
  assert.equal(risks.length, 1);
  assert.match(risks[0]!.title, /Untracked TSLA/);

  // Without the orphan the same caps allow the AAPL entry.
  t.world.positions.delete('TSLA');
  await runTrader(t.engine);
  assert.deepEqual(t.world.opens.map((o) => o.symbol).sort(), ['AAPL', 'TSLA']);
});
