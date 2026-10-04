import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketSession } from '@bellwether/shared';
import { SESSION_SCORE, computeSignal, ema, rsi, type SignalInput } from './signal.ts';
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

test('the session scales conviction in whichever direction the indicators lean, with no long or short bias of its own', () => {
  const up = candles(0.0005);
  const down = candles(-0.0005);
  const score = (c: Omit<SignalInput, 'session'>, session: MarketSession) => computeSignal({ ...c, session }).score;
  // Regular hours make a bearish read more bearish (it used to pull it 15 points toward long), weekends less.
  assert.equal(score(down, 'regular') - score(down, 'weekend'), -(SESSION_SCORE.regular - SESSION_SCORE.weekend));
  assert.equal(score(down, 'overnight') - score(down, 'weekend'), SESSION_SCORE.weekend - SESSION_SCORE.overnight);
  // A bullish read keeps the old gating (regular hours clamp at 100 here, so compare overnight).
  assert.equal(score(up, 'overnight') - score(up, 'weekend'), SESSION_SCORE.overnight - SESSION_SCORE.weekend);
});
