import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STRATEGIES } from '@bellwether/shared';
import { evaluateExit, stopPrice, strictestRules, type ExitParams, type ExitState } from './exits.ts';

const LADDER = STRATEGIES.balanced.exits;
const params: ExitParams = { stopLoss: -0.3, ladder: LADDER, liquidationBufferPct: 0.15, signalScore: null };

/** Long 10x, $100 collateral, entry 100; PnL follows the mark. */
function at(mark: number, over: Partial<ExitState> = {}): ExitState {
  const base: ExitState = {
    side: 'long',
    entryPrice: 100,
    markPrice: mark,
    leverage: 10,
    collateralUsd: 100,
    unrealizedPnlUsd: 0,
    liquidationPrice: 91,
    stage: 'open',
    bestPrice: 100,
    tp1Hit: false,
    tp2Hit: false,
    liqReduced: false,
    ...over,
  };
  const s = { ...base, ...over, markPrice: mark };
  if (over.unrealizedPnlUsd === undefined) s.unrealizedPnlUsd = (1000 * (mark - s.entryPrice)) / s.entryPrice;
  return s;
}

test('hard stop closes at the strategy stop on collateral', () => {
  assert.deepEqual(evaluateExit(at(96.9), params), { kind: 'close', action: 'stop', reason: 'stop -31%' });
  assert.equal(evaluateExit(at(97.5), params).kind, 'hold');
});

test('a small favorable move arms breakeven without trading', () => {
  const d = evaluateExit(at(100.5, { unrealizedPnlUsd: 0.5 }), params);
  assert.equal(d.kind, 'hold');
  assert.equal(d.kind === 'hold' && d.patch.stage, 'breakeven');
});

test('TP1 takes a quarter off at +0.5%', () => {
  const d = evaluateExit(at(100.5), params);
  assert.equal(d.kind, 'reduce');
  if (d.kind !== 'reduce') return;
  assert.equal(d.fraction, LADDER.tp1Fraction);
  assert.equal(d.reason, 'take-profit 1');
  assert.deepEqual({ stage: d.patch.stage, tp1Hit: d.patch.tp1Hit }, { stage: 'tp1', tp1Hit: true });
});

test('TP2 takes a third of the rest at +1% and starts trailing', () => {
  const d = evaluateExit(at(101, { stage: 'tp1', tp1Hit: true }), params);
  assert.equal(d.kind, 'reduce');
  if (d.kind !== 'reduce') return;
  assert.equal(d.fraction, LADDER.tp2Fraction);
  assert.deepEqual({ stage: d.patch.stage, tp2Hit: d.patch.tp2Hit }, { stage: 'trailing', tp2Hit: true });
});

test('trailing tracks the best price and closes on a pullback while in profit', () => {
  const trailing = { stage: 'trailing' as const, tp1Hit: true, tp2Hit: true, bestPrice: 101 };
  const up = evaluateExit(at(102, trailing), params);
  assert.equal(up.kind === 'hold' && up.patch.bestPrice, 102);
  assert.deepEqual(evaluateExit(at(101.4, { ...trailing, bestPrice: 102 }), params), { kind: 'close', action: 'close', reason: 'trailing stop' });
  assert.equal(evaluateExit(at(101.6, { ...trailing, bestPrice: 102 }), params).kind, 'hold');
});

test('once protected, returning to entry closes at breakeven', () => {
  for (const stage of ['breakeven', 'tp1', 'trailing'] as const) {
    assert.deepEqual(evaluateExit(at(99.95, { stage }), params), { kind: 'close', action: 'close', reason: 'breakeven stop' });
  }
  assert.equal(evaluateExit(at(99.95), params).kind, 'hold');
});

test('liquidation buffer halves once, then closes deeper in the buffer', () => {
  const near = at(92, { unrealizedPnlUsd: -20 });
  const first = evaluateExit(near, params);
  assert.equal(first.kind === 'reduce' && first.fraction, 0.5);
  assert.equal(evaluateExit({ ...near, liqReduced: true }, params).kind, 'hold');
  assert.deepEqual(evaluateExit({ ...at(91.5, { unrealizedPnlUsd: -20 }), liqReduced: true }, params), {
    kind: 'close',
    action: 'stop',
    reason: 'liquidation buffer',
  });
});

test('a gap deep into the liquidation buffer closes at once instead of halving first', () => {
  const close = { kind: 'close', action: 'stop', reason: 'liquidation buffer' };
  assert.deepEqual(evaluateExit(at(91.5, { unrealizedPnlUsd: -20 }), params), close);
  assert.deepEqual(evaluateExit(at(90, { unrealizedPnlUsd: -20 }), params), close);
  assert.deepEqual(evaluateExit(at(108.5, { side: 'short', liquidationPrice: 109, unrealizedPnlUsd: -20 }), params), close);
});

test('signal flip exits a losing position but not a winning one', () => {
  const flip = { ...params, signalScore: -40 };
  assert.deepEqual(evaluateExit(at(98.8), flip), { kind: 'close', action: 'close', reason: 'signal flip' });
  assert.equal(evaluateExit(at(99.5), flip).kind, 'hold');
});

test('shorts mirror the ladder', () => {
  const short = (mark: number) => at(mark, { side: 'short', liquidationPrice: 109, unrealizedPnlUsd: (1000 * (100 - mark)) / 100 });
  assert.equal(evaluateExit(short(99.5), params).kind, 'reduce');
  assert.equal(evaluateExit(short(103.1), params).kind, 'close');
  const stop = stopPrice({ side: 'short', entryPrice: 100, leverage: 10, stage: 'open', bestPrice: 100 }, -0.3, LADDER);
  assert.ok(stop !== null && Math.abs(stop - 103) < 1e-9);
});

test('the strictest trading participant sets the rules', () => {
  assert.equal(strictestRules(['degen', 'steady', 'burn'], -0.3).stopLoss, STRATEGIES.steady.stopLoss);
  assert.equal(strictestRules(['burn'], -0.3).stopLoss, -0.3);
});
