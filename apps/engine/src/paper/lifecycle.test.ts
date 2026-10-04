/**
 * End-to-end paper lifecycle: the real paper integrations (simulated launchpad claims, DEX,
 * bridge, venue and wallet) over a fake read-only network whose marks the test controls,
 * driven worker by worker through `workerDefs` on a SQLite file with a fake clock.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ActivityKind, Address, WorkerId } from '@bellwether/shared';
import { listActivity } from '../activity.ts';
import { loadConfig } from '../config.ts';
import { openDb, type Db } from '../db.ts';
import { createEngine, killSwitchOn, utcDayStart, type Engine } from '../engine.ts';
import { ACCOUNTS, ACCOUNT_IDS, Ledger, type Account } from '../ledger.ts';
import { burnTotals, getPosition, listTrades, openPositions, sharesOf, type PositionRow } from '../positions.ts';
import { REGULAR_SESSION, address, createFakeWorld, seedToken, type FakeWorld } from '../testing/fakes.ts';
import { getToken } from '../tokens.ts';
import { proofResponse } from '../views.ts';
import { MISSING_PASSES } from '../workers/guardian.ts';
import { workerDefs } from '../workers/index.ts';
import { PAPER_BRIDGE_HAIRCUT, createPaperIntegrations } from './index.ts';
import { paperVenueState } from './venue.ts';

const A = address(0xa); // balanced, token cap 7x
const B = address(0xb); // degen, token cap 20x
const C = address(0xc); // burn-only
const PROTOCOL_TOKEN = address(0xf100);
const ETH_USD = 4000;
const SYMBOL = 'AAPL';

// ─── harness ─────────────────────────────────────────────────────────────────
interface Paper {
  engine: Engine;
  /** Advances the clock past every market-data cache TTL, then runs the worker as the scheduler would. */
  run(worker: WorkerId): Promise<string>;
  close(): void;
}

interface Lab {
  world: FakeWorld;
  now: { t: number };
  /** Boots a paper engine on the lab's database file, wired exactly like main.ts. */
  boot(): Paper;
}

function paperLab(t: TestContext): Lab {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellwether-paper-'));
  const dbPath = path.join(dir, 'bellwether.db');
  const world = createFakeWorld();
  world.ethUsd = ETH_USD;
  // Listed up to 20x so the strategy and token caps decide the leverage.
  world.markets = [{ symbol: SYMBOL, venueSymbol: `xyz:${SYMBOL}`, maxLeverage: 20, open: true, markPrice: 200 }];
  const now = { t: REGULAR_SESSION };
  const dbs: Db[] = [];
  t.after(() => {
    for (const db of dbs) if (db.raw.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const boot = (): Paper => {
    const config = loadConfig({ DB_PATH: dbPath, PROTOCOL_ADDRESS: world.io.wallet.address, PROTOCOL_TOKEN_ADDRESS: PROTOCOL_TOKEN });
    const db = openDb(dbPath);
    dbs.push(db);
    const clock = () => now.t;
    const io = createPaperIntegrations(world.io, { db, ledger: new Ledger(db), clock, rhcGasReserveEth: config.risk.rhcGasReserveEth });
    const engine = createEngine({ config, db, io, clock });
    const defs = new Map(workerDefs(engine).map((d) => [d.id, d]));
    return {
      engine,
      run: (worker) => {
        now.t += 60_000;
        return defs.get(worker)!.run();
      },
      close: () => db.close(),
    };
  };
  return { world, now, boot };
}

const gwei = (eth: number) => Math.round(eth * 1e9);

/** Creator fees accrue on-chain (the read-only launchpad's cumulative claimable grows). */
function accrue(world: FakeWorld, token: Address, eth: number): void {
  world.claimable.set(token, (world.claimable.get(token) ?? 0n) + BigInt(gwei(eth)) * 10n ** 9n);
}

function setMark(world: FakeWorld, price: number): void {
  world.markets = world.markets.map((m) => (m.symbol === SYMBOL ? { ...m, markPrice: price } : m));
}

function onlyPosition(p: Paper): PositionRow {
  const open = openPositions(p.engine.db);
  assert.equal(open.length, 1, 'exactly one open pooled position');
  return open[0]!;
}

/** Fills of a position, oldest first. */
function tradesOf(p: Paper, positionId: string): { action: string; reason: string }[] {
  return listTrades(p.engine.db, { limit: 100 })
    .filter((t) => t.positionId === positionId)
    .reverse()
    .map((t) => ({ action: t.action, reason: t.reason }));
}

function activityKinds(p: Paper): ActivityKind[] {
  return listActivity(p.engine.db, { limit: 1000 })
    .reverse()
    .map((a) => a.kind);
}

function assertSubsequence(actual: readonly string[], expected: readonly string[]): void {
  let i = 0;
  for (const k of actual) if (k === expected[i]) i++;
  assert.equal(i, expected.length, `expected ${expected.join(' → ')} in order within ${actual.join(', ')}`);
}

function assertNoNegativeAccounts(ledger: Ledger): void {
  for (const [token, b] of ledger.books()) {
    for (const account of ACCOUNT_IDS) {
      if (!ACCOUNTS[account].signed) assert.ok(b[account] >= 0, `${token} ${account} is negative: ${b[account]}`);
    }
  }
}

function assertBook(ledger: Ledger, token: Address, expected: Partial<Record<Account, number>>): void {
  const b = ledger.book(token);
  const actual = Object.fromEntries(Object.keys(expected).map((k) => [k, b[k as Account]]));
  assert.deepEqual(actual, expected, `book of ${token}`);
}

/**
 * Runs the reconciler and checks the /proof view. Paper wallets are derived from the simulation
 * itself, so the books must match to rounding; the only ETH surplus is the simulated gas float.
 */
async function assertReconciled(p: Paper): Promise<void> {
  await p.run('reconciler');
  const proof = proofResponse(p.engine);
  assert.equal(proof.mode, 'paper');
  const items = proof.reconciliation.items;
  assert.deepEqual(items.map((i) => `${i.asset}@${i.chain}`), ['ETH@rhc', 'USDC@hyperliquid']);
  for (const it of items) assert.ok(it.ok, `${it.asset}@${it.chain} drift ${it.drift}`);
  const [eth, usd] = items;
  assert.ok(Math.abs(eth!.drift - p.engine.config.risk.rhcGasReserveEth) < 1e-9, `ETH drift ${eth!.drift}`);
  assert.ok(Math.abs(usd!.drift) < 0.001, `USDC drift ${usd!.drift}`);
}

/** Claims, fee buybacks and the first bridge for A (0.1 ETH) and B (0.05 ETH), then the trader; returns the budgets it saw. */
async function fundAndOpen(p: Paper, world: FakeWorld): Promise<{ A: number; B: number }> {
  accrue(world, A, 0.1);
  accrue(world, B, 0.05);
  await p.run('claimer');
  await p.run('buyback');
  await p.run('treasury');
  const budgets = { A: p.engine.ledger.book(A).trading_usd, B: p.engine.ledger.book(B).trading_usd };
  await p.run('trader');
  return budgets;
}

// ─── scenarios ───────────────────────────────────────────────────────────────
test('profit path: fees split and burn, one pooled long rides the exit ladder, profit is crossed into burns', async (t) => {
  const lab = paperLab(t);
  const { world } = lab;
  const p = lab.boot();
  const { ledger } = p.engine;
  const protocolToken = p.engine.config.protocolToken!;
  seedToken(p.engine, { address: A, strategy: 'balanced', maxLeverage: 7 });
  seedToken(p.engine, { address: B, strategy: 'degen', maxLeverage: 20 });
  seedToken(p.engine, { address: C, strategy: 'burn', maxLeverage: 0 });

  // Claims split 60/25/15 for traders and 0/85/15 for burn-only.
  accrue(world, A, 0.1);
  accrue(world, B, 0.05);
  accrue(world, C, 0.02);
  await p.run('claimer');
  assertBook(ledger, A, { fees_eth: gwei(0.1), trading_eth: gwei(0.06), token_buyback_eth: gwei(0.025), protocol_buyback_eth: gwei(0.015) });
  assertBook(ledger, B, { fees_eth: gwei(0.05), trading_eth: gwei(0.03), token_buyback_eth: gwei(0.0125), protocol_buyback_eth: gwei(0.0075) });
  assertBook(ledger, C, { fees_eth: gwei(0.02), trading_eth: 0, token_buyback_eth: gwei(0.017), protocol_buyback_eth: gwei(0.003) });

  // Fee buyback budgets burn right away: each token's own, and the pooled $PROTOCOL_TOKEN budget.
  await p.run('buyback');
  for (const [token, spent] of [[A, 0.04], [B, 0.02], [C, 0.02]] as const) {
    assertBook(ledger, token, { token_buyback_eth: 0, protocol_buyback_eth: 0, buyback_spent_eth: gwei(spent) });
  }
  const firstBurns = burnTotals(p.engine.db).byTarget;
  for (const target of [A, B, C, protocolToken]) assert.ok((firstBurns.get(target) ?? 0n) > 0n, `burned ${target}`);

  // Treasury bridges the trading ETH to USDC and moves it into paper margin.
  await p.run('treasury');
  const bridgedUsd = 0.09 * ETH_USD * (1 - PAPER_BRIDGE_HAIRCUT);
  assert.ok(Math.abs(paperVenueState(p.engine.db).freeUsd - bridgedUsd) < 1e-6);
  assert.equal(paperVenueState(p.engine.db).arbitrumUsdc, 0);
  assertBook(ledger, A, { trading_eth: 0, trading_usd: Math.round(((bridgedUsd * 2) / 3) * 1e6) });
  assertBook(ledger, B, { trading_eth: 0, trading_usd: Math.round((bridgedUsd / 3) * 1e6) });
  const budgetA = ledger.book(A).trading_usd;
  const budgetB = ledger.book(B).trading_usd;

  // One pooled long on the shared market: shares follow contributions, leverage the strictest cap (A's 7x).
  await p.run('trader');
  const position = onlyPosition(p);
  assert.deepEqual({ market: position.market, side: position.side, leverage: position.leverage }, { market: SYMBOL, side: 'long', leverage: 7 });
  const shares = new Map(sharesOf(p.engine.db, position.id).map((s) => [s.token, s]));
  assert.deepEqual([...shares.keys()].sort(), [A, B].sort());
  assert.ok(Math.abs(shares.get(A)!.share - budgetA / (budgetA + budgetB)) < 1e-6);
  assert.equal(shares.get(A)!.collateralMicro + shares.get(B)!.collateralMicro, position.collateralMicro);
  assert.equal(ledger.book(A).deployed_usd + ledger.book(B).deployed_usd, position.collateralMicro);
  const venuePositions = await p.engine.io.venues[0]!.positions();
  assert.equal(venuePositions.length, 1);
  assert.ok(Math.abs(venuePositions[0]!.collateralUsd - position.collateralMicro / 1e6) < 1e-6);
  assert.equal(getToken(p.engine.db, A)!.decision.verdict, 'in-position');
  assert.equal(getToken(p.engine.db, B)!.decision.verdict, 'in-position');
  assert.equal(getToken(p.engine.db, C)!.decision.verdict, 'burn-only');

  // Guardian at entry holds and syncs the venue's liquidation price into the book.
  const entry = position.entryPrice;
  await p.run('guardian');
  assert.ok(getPosition(p.engine.db, position.id)!.liquidationPrice! < entry);
  await assertReconciled(p);

  // Mark rises: TP1, TP2, a new high, then the pullback closes the rest. Books reconcile while open.
  setMark(world, entry * 1.006);
  await p.run('guardian');
  assert.equal(getPosition(p.engine.db, position.id)!.stage, 'tp1');
  await assertReconciled(p);

  setMark(world, entry * 1.012);
  await p.run('guardian');
  assert.equal(getPosition(p.engine.db, position.id)!.stage, 'trailing');
  await assertReconciled(p);

  setMark(world, entry * 1.02);
  await p.run('guardian');
  assert.ok(Math.abs(getPosition(p.engine.db, position.id)!.bestPrice - entry * 1.02) < 1e-9);

  setMark(world, entry * 1.014);
  await p.run('guardian');
  assert.equal(openPositions(p.engine.db).length, 0);
  const trades = tradesOf(p, position.id);
  assert.deepEqual(trades.map((x) => x.action), ['open', 'reduce', 'reduce', 'close']);
  assert.deepEqual(trades.slice(1).map((x) => x.reason), ['take-profit 1', 'take-profit 2', 'trailing stop']);
  assert.deepEqual(await p.engine.io.venues[0]!.positions(), []);

  // Realized profit is split by share, then 80/20 into token / $PROTOCOL_TOKEN buyback earmarks.
  const a = ledger.book(A);
  const b = ledger.book(B);
  assert.equal(a.deployed_usd + b.deployed_usd, 0);
  assert.ok(a.realized_pnl_usd > 0 && b.realized_pnl_usd > 0);
  const profitA = a.profit_token_usd + a.profit_protocol_usd;
  const profitB = b.profit_token_usd + b.profit_protocol_usd;
  assert.ok(Math.abs(profitA / profitB - budgetA / budgetB) < 1e-3);
  // One floor-rounding micro-USD per exit fill at most.
  for (const x of [a, b]) assert.ok(Math.abs(x.profit_protocol_usd - 0.2 * (x.profit_token_usd + x.profit_protocol_usd)) <= 3);
  assert.equal(ledger.book(C).profit_token_usd, 0);
  await assertReconciled(p);

  // Fresh fees arrive as trading ETH on RHC: the treasury crosses the profit against it, then bridges the rest.
  accrue(world, A, 0.1);
  accrue(world, B, 0.05);
  accrue(world, C, 0.02);
  await p.run('claimer');
  await p.run('treasury');
  for (const x of [ledger.book(A), ledger.book(B)]) {
    assert.ok(x.profit_token_usd + x.profit_protocol_usd <= 8, 'profit fully crossed up to rounding');
    assert.equal(x.trading_eth, 0);
  }
  // The buyback ETH A received beyond its fee split is worth its profit at the crossing price (4 micro-USD per gwei).
  const crossedA = ledger.book(A).token_buyback_eth + ledger.book(A).protocol_buyback_eth - gwei(0.04);
  assert.ok(Math.abs((crossedA * ETH_USD) / 1000 - profitA) <= 10);

  // Buyback burns the tokens and $PROTOCOL_TOKEN out of fee and profit budgets alike.
  await p.run('buyback');
  for (const token of [A, B, C]) assertBook(ledger, token, { trading_eth: 0, token_buyback_eth: 0, protocol_buyback_eth: 0 });
  assert.ok(ledger.book(A).buyback_spent_eth > gwei(0.08) && ledger.book(B).buyback_spent_eth > gwei(0.04));
  assert.equal(ledger.book(C).buyback_spent_eth, ledger.book(C).fees_eth, 'burn-only burns every fee');
  const burns = burnTotals(p.engine.db).byTarget;
  for (const target of [A, B, C, protocolToken]) assert.ok(burns.get(target)! > firstBurns.get(target)!, `burned more ${target}`);

  await assertReconciled(p);
  assertNoNegativeAccounts(ledger);
  const kinds = activityKinds(p);
  assertSubsequence(kinds, ['claim', 'buyback', 'bridge', 'open', 'reduce', 'reduce', 'close', 'claim', 'bridge', 'buyback']);
  assert.ok(!kinds.some((k) => ['risk', 'stop', 'liquidated', 'kill-switch'].includes(k)), kinds.join(', '));
});

test('loss path: the strategy stop returns collateral net of loss, a crash between guardian runs is a liquidation', async (t) => {
  const lab = paperLab(t);
  const { world } = lab;
  const p = lab.boot();
  const { ledger } = p.engine;
  seedToken(p.engine, { address: A, strategy: 'balanced', maxLeverage: 7 });
  seedToken(p.engine, { address: B, strategy: 'degen', maxLeverage: 20 });
  const before = await fundAndOpen(p, world);
  const first = onlyPosition(p);
  assert.equal(first.leverage, 7);
  await p.run('guardian');

  // Through the strictest stop (balanced, -30% of collateral) before the liquidation buffer.
  setMark(world, first.entryPrice * (1 - 0.044));
  await p.run('guardian');
  assert.equal(openPositions(p.engine.db).length, 0);
  assert.deepEqual(tradesOf(p, first.id).map((x) => x.action), ['open', 'stop']);
  for (const [token, budget] of [[A, before.A], [B, before.B]] as const) {
    const x = ledger.book(token);
    const share = sharesOf(p.engine.db, first.id).find((s) => s.token === token)!;
    assert.equal(x.deployed_usd, 0);
    const lossPct = x.realized_pnl_usd / share.collateralMicro;
    assert.ok(lossPct < -0.3 && lossPct > -0.35, `loss ${lossPct}`);
    assert.ok(Math.abs(x.trading_usd - (budget + x.realized_pnl_usd)) <= 1, 'collateral back net of loss and fees');
    assert.deepEqual([x.profit_token_usd, x.profit_protocol_usd], [0, 0]);
  }
  const dayStart = utcDayStart(lab.now.t);
  assert.equal(ledger.realizedSince(dayStart), ledger.book(A).realized_pnl_usd + ledger.book(B).realized_pnl_usd);
  await assertReconciled(p);

  // No profit, so nothing is crossed or bought back beyond the original fee budgets.
  await p.run('treasury');
  await p.run('buyback');
  assert.equal(p.engine.db.get<{ n: number }>(`SELECT count(*) AS n FROM ledger WHERE ref_kind = 'cross'`)!.n, 0);
  assertBook(ledger, A, { buyback_spent_eth: gwei(0.04), token_buyback_eth: 0, protocol_buyback_eth: 0 });
  assertBook(ledger, B, { buyback_spent_eth: gwei(0.02), token_buyback_eth: 0, protocol_buyback_eth: 0 });

  // The day's loss halts balanced A (limit 20%); degen B (35%) re-enters alone at its 20x cap.
  await p.run('trader');
  assert.equal(getToken(p.engine.db, A)!.decision.verdict, 'daily-loss-limit');
  const second = onlyPosition(p);
  assert.deepEqual(sharesOf(p.engine.db, second.id).map((s) => s.token), [B]);
  assert.equal(second.leverage, 20);
  // The venue's liquidation price is booked with the entry, before any guardian sync.
  const liquidation = second.liquidationPrice!;
  assert.ok(liquidation > second.entryPrice * (1 - 1 / 20) && liquidation < second.entryPrice);
  const bBefore = ledger.book(B);

  // Gap just through the liquidation price before the guardian's next runs: the venue keeps the whole collateral.
  setMark(world, liquidation * 0.995);
  for (let i = 0; i < MISSING_PASSES; i++) await p.run('guardian');
  assert.equal(getPosition(p.engine.db, second.id)!.closeReason, 'liquidated');
  assert.deepEqual(tradesOf(p, second.id).map((x) => x.action), ['open', 'liquidated']);
  assert.deepEqual(await p.engine.io.venues[0]!.positions(), []);
  const bAfter = ledger.book(B);
  assert.equal(bAfter.deployed_usd, 0);
  assert.equal(bAfter.realized_pnl_usd, bBefore.realized_pnl_usd - bBefore.deployed_usd, 'the whole collateral is lost');
  assert.equal(bAfter.trading_usd, bBefore.trading_usd);
  assert.equal(bAfter.profit_token_usd + bAfter.profit_protocol_usd, 0);
  assert.equal(killSwitchOn(p.engine), false);

  await assertReconciled(p);
  assertNoNegativeAccounts(ledger);
  assertSubsequence(activityKinds(p), ['claim', 'bridge', 'open', 'stop', 'open', 'liquidated']);
});

test('restart safety: a rebooted engine keeps managing the same position and replayed claims are no-ops', async (t) => {
  const lab = paperLab(t);
  const { world } = lab;
  const first = lab.boot();
  seedToken(first.engine, { address: A, strategy: 'balanced', maxLeverage: 7 });
  seedToken(first.engine, { address: B, strategy: 'degen', maxLeverage: 20 });
  await fundAndOpen(first, world);
  const position = onlyPosition(first);
  await first.run('guardian');
  setMark(world, position.entryPrice * 1.006);
  await first.run('guardian');
  assert.equal(getPosition(first.engine.db, position.id)!.stage, 'tp1');
  const claimRefs = first.engine.db.all<{ token: Address; ref_id: string }>(
    `SELECT DISTINCT token, ref_id FROM ledger WHERE ref_kind = 'claim' ORDER BY token`,
  );
  assert.equal(claimRefs.length, 2);
  const books = first.engine.ledger.books();
  first.close();

  // Process restart: same database file, same outside world, fresh engine and caches.
  const p = lab.boot();
  const { ledger } = p.engine;
  assert.deepEqual(ledger.books(), books);
  assert.equal(onlyPosition(p).id, position.id);

  // No new on-chain fees: the persisted paper claim baseline prevents a double claim, and replayed refs are no-ops.
  await p.run('claimer');
  for (const { token, ref_id } of claimRefs) {
    const replay = ledger.recordClaim({ token, strategy: 'balanced', amountWei: 10n ** 18n, tx: { chain: 'rhc', hash: ref_id }, at: lab.now.t });
    assert.equal(replay, null);
  }
  assert.deepEqual(ledger.books(), books);

  // The trader sees the pooled position and does not open a second one.
  await p.run('trader');
  assert.equal(onlyPosition(p).id, position.id);
  assert.equal((await p.engine.io.venues[0]!.positions()).length, 1);
  assert.equal(getToken(p.engine.db, A)!.decision.verdict, 'in-position');

  // The guardian resumes the ladder where it left off: no second TP1, then TP2 and the trailing close.
  await p.run('guardian');
  setMark(world, position.entryPrice * 1.012);
  await p.run('guardian');
  setMark(world, position.entryPrice * 1.02);
  await p.run('guardian');
  setMark(world, position.entryPrice * 1.014);
  await p.run('guardian');
  const trades = tradesOf(p, position.id);
  assert.deepEqual(trades.map((x) => x.action), ['open', 'reduce', 'reduce', 'close']);
  assert.deepEqual(trades.slice(1).map((x) => x.reason), ['take-profit 1', 'take-profit 2', 'trailing stop']);
  assert.equal(openPositions(p.engine.db).length, 0);
  assert.equal(p.engine.db.get<{ n: number }>(`SELECT count(*) AS n FROM trades WHERE action = 'open'`)!.n, 1);

  await assertReconciled(p);
  assertNoNegativeAccounts(ledger);
});
