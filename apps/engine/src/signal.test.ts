import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_SCORE, computeSignal, ema, rsi } from './signal.ts';
import { trendCandles } from './testing/fakes.ts';

test('ema and rsi match hand-computed values', () => {
  // k = 2/3: 1 → 2*2/3 + 1/3 = 5/3 → 3*2/3 + 5/9 = 23/9
  assert.ok(Math.abs(ema([1, 2, 3], 2) - 23 / 9) < 1e-12);
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 5), 100);
  assert.equal(rsi([1, 2, 3], 14), 50);
  // Seed window only: gains 2, losses 2 → RS 1 → RSI 50.
  assert.equal(rsi([1, 2, 1, 2, 1], 4), 50);
});

function candles(stepPct: number) {
  return {
    fast: trendCandles(120, { stepPct }),
    mid: trendCandles(100, { interval: '15m', stepPct: stepPct * 2 }),
    slow: trendCandles(220, { interval: '1h', stepPct: stepPct * 2 }),
  };
}

test('a steady uptrend in regular hours scores a confident long', () => {
  const s = computeSignal({ ...candles(0.0005), session: 'regular' });
  assert.ok(s.score >= 60, `score ${s.score}`);
  assert.equal(s.bias, 'long');
  assert.ok(s.suggestedLeverage >= 15);
});

test('a steady downtrend scores a short bias', () => {
  const s = computeSignal({ ...candles(-0.0005), session: 'regular' });
  assert.ok(s.score <= -25, `score ${s.score}`);
  assert.equal(s.bias, 'short');
});

test('too little data is neutral', () => {
  const s = computeSignal({ fast: trendCandles(49), mid: trendCandles(20), slow: [], session: 'regular' });
  assert.deepEqual({ score: s.score, bias: s.bias }, { score: 0, bias: 'wait' });
});

test('session weight shifts the score by the session difference', () => {
  const flat = candles(0.00002);
  const regular = computeSignal({ ...flat, session: 'regular' });
  const weekend = computeSignal({ ...flat, session: 'weekend' });
  assert.equal(regular.score - weekend.score, SESSION_SCORE.regular - SESSION_SCORE.weekend);
});
