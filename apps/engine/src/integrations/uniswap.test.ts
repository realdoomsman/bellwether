import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minAmountOut } from './uniswap.ts';

test('minimum output applies the slippage budget and rounds down', () => {
  assert.equal(minAmountOut(10_000n, 150), 9_850n);
  assert.equal(minAmountOut(999n, 1), 998n); // 998.9 → 998: never above the budget
  assert.equal(minAmountOut(10n ** 18n, 0), 10n ** 18n);
  assert.equal(minAmountOut(10n ** 18n, 50), 995n * 10n ** 15n);
});

test('slippage outside [0, 10000) or fractional is rejected', () => {
  assert.throws(() => minAmountOut(1n, 10_000), RangeError);
  assert.throws(() => minAmountOut(1n, -1), RangeError);
  assert.throws(() => minAmountOut(1n, 1.5), RangeError);
});
