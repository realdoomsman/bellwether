import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listActivity } from '../activity.ts';
import { killSwitchOn, setKillSwitch } from '../engine.ts';
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
  assert.ok(Math.abs(a.profit_token_usd / a.profit_protocol_usd - 4) < 0.01);
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

test('a loss carried over from yesterday does not latch the kill switch; a new loss today does', async () => {
  const { t } = await openPooled();
  const live = t.world.positions.get('AAPL')!;
  const at = (pnl: number) => t.world.positions.set('AAPL', { ...live, markPrice: live.entryPrice * 0.99, unrealizedPnlUsd: pnl, collateralUsd: 10_000 });
  at(-301);
  await runGuardian(t.engine);
  assert.equal(killSwitchOn(t.engine), true);
  setKillSwitch(t.engine, false, 'operator reviewed');

  t.now.t += 86_400_000;
  await runGuardian(t.engine);
  assert.equal(killSwitchOn(t.engine), false);

  at(-601);
  await runGuardian(t.engine);
  assert.equal(killSwitchOn(t.engine), true);
});

test('one failing position does not stop the others and is paged once while it keeps failing', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A, market: 'AAPL' });
  seedToken(t.engine, { address: B, market: 'TSLA' });
  fundUsd(t.engine, A, 300);
  fundUsd(t.engine, B, 300);
  await runTrader(t.engine);
  assert.equal(openPositions(t.engine.db).length, 2);
  for (const [symbol, live] of t.world.positions) {
    t.world.positions.set(symbol, { ...live, markPrice: live.entryPrice * 1.006, unrealizedPnlUsd: live.sizeUsd * 0.006 });
  }
  t.world.failingReduces.add('AAPL');
  const risks = () => listActivity(t.engine.db, { limit: 50 }).filter((a) => a.kind === 'risk');

  assert.match(await runGuardian(t.engine), /TSLA take-profit 1; 1 failed: AAPL: reduce AAPL rejected/);
  const tsla = openPositions(t.engine.db).find((p) => p.market === 'TSLA')!;
  assert.equal(tsla.stage, 'tp1');
  assert.equal(risks().length, 1);
  assert.match(risks()[0]!.title, /AAPL.*reduce AAPL rejected/);

  await runGuardian(t.engine);
  assert.equal(risks().length, 1);

  t.world.failingReduces.delete('AAPL');
  await runGuardian(t.engine);
  assert.equal(openPositions(t.engine.db).find((p) => p.market === 'AAPL')!.stage, 'tp1');
  assert.equal(risks().length, 1);
});

test('the guardian adopts an open whose fill never reached the trader, once', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  fundUsd(t.engine, A, 300);
  t.world.openErrorAfterFill = 'connection reset';
  await runTrader(t.engine);
  t.world.openErrorAfterFill = null;

  assert.match(await runGuardian(t.engine), /AAPL adopted/);
  const [p] = openPositions(t.engine.db);
  assert.equal(p!.market, 'AAPL');
  assert.ok(Math.abs(t.engine.ledger.book(A).deployed_usd - t.world.opens[0]!.collateralUsd * 1e6) <= 1);
  const books = t.engine.ledger.books();

  await runGuardian(t.engine);
  await runTrader(t.engine);
  assert.deepEqual(t.engine.ledger.books(), books);
  assert.equal(listTrades(t.engine.db, { limit: 10 }).length, 1);
  assert.equal(listActivity(t.engine.db, { limit: 50 }).filter((a) => a.kind === 'risk').length, 0);
});
