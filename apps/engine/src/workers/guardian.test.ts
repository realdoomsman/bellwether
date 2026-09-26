import assert from 'node:assert/strict';
import { test } from 'node:test';
import { killSwitchOn } from '../engine.ts';
import { getPosition, listTrades, openPositions } from '../positions.ts';
import { address, createTestEngine, fundUsd, seedToken } from '../testing/fakes.ts';
import { runGuardian } from './guardian.ts';
import { runTrader } from './trader.ts';

const A = address(0xa);
const B = address(0xb);

async function openPooled() {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  seedToken(t.engine, { address: B });
  fundUsd(t.engine, A, 300);
  fundUsd(t.engine, B, 100);
  await runTrader(t.engine);
  const [p] = openPositions(t.engine.db);
  assert.ok(p);
  return { t, p };
}

test('take-profit reduce books profit into both tokens’ buyback earmarks', async () => {
  const { t, p } = await openPooled();
  const live = t.world.positions.get('AAPL')!;
  const mark = live.entryPrice * 1.006;
  t.world.positions.set('AAPL', { ...live, markPrice: mark, unrealizedPnlUsd: live.sizeUsd * 0.006 });

  await runGuardian(t.engine);

  assert.deepEqual(t.world.reduces, [{ symbol: 'AAPL', fraction: 0.25 }]);
  const row = getPosition(t.engine.db, p.id)!;
  assert.equal(row.stage, 'tp1');
  assert.equal(row.tp1Hit, true);
  const [trade] = listTrades(t.engine.db, { limit: 1 });
  assert.deepEqual({ action: trade!.action, reason: trade!.reason }, { action: 'reduce', reason: 'take-profit 1' });
  const a = t.engine.ledger.book(A);
  const b = t.engine.ledger.book(B);
  assert.ok(a.profit_token_usd > 0 && b.profit_token_usd > 0);
  assert.ok(Math.abs(a.profit_token_usd / b.profit_token_usd - 3) < 0.01);
  assert.ok(Math.abs(a.profit_token_usd / a.profit_floor_usd - 4) < 0.01);
});

test('a position that vanished past its liquidation price is booked as liquidated', async () => {
  const { t, p } = await openPooled();
  await runGuardian(t.engine); // syncs the venue liquidation price into the book
  const liq = getPosition(t.engine.db, p.id)!.liquidationPrice!;
  t.world.positions.delete('AAPL');
  t.world.markets = t.world.markets.map((m) => (m.symbol === 'AAPL' ? { ...m, markPrice: liq * 0.99 } : m));

  await runGuardian(t.engine);

  const row = getPosition(t.engine.db, p.id)!;
  assert.ok(row.closedAt !== null);
  assert.equal(row.closeReason, 'liquidated');
  assert.equal(t.engine.ledger.book(A).deployed_usd, 0);
  assert.equal(t.engine.ledger.book(B).deployed_usd, 0);
  assert.ok(t.engine.ledger.book(A).realized_pnl_usd < 0);
  assert.equal(listTrades(t.engine.db, { limit: 1 })[0]!.action, 'liquidated');
});

test('the global daily loss limit trips the kill switch', async () => {
  const { t } = await openPooled();
  const live = t.world.positions.get('AAPL')!;
  // Loss beyond GLOBAL_DAILY_LOSS_USD but above the stop and outside the liquidation buffer.
  t.world.positions.set('AAPL', { ...live, markPrice: live.entryPrice * 0.99, unrealizedPnlUsd: -301, collateralUsd: 5000 });
  await runGuardian(t.engine);
  assert.equal(killSwitchOn(t.engine), true);
});
