import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pct, price, tone, usd } from './format.ts';

test('values that round to zero print without a sign and read as neutral', () => {
  assert.equal(usd(-0.004), '$0.00');
  assert.equal(usd(-0.004, { signed: true }), '$0.00');
  assert.equal(tone(usd(-0.004, { signed: true })), '');
  assert.equal(pct(-0.00001, { signed: true }), '0.00%');
  assert.equal(pct(-0.0004, { signed: true, digits: 1 }), '0.0%');
  assert.equal(tone(pct(-0.00001, { signed: true })), '');
});

test('real gains and losses keep their sign and tone', () => {
  assert.equal(usd(-0.006), '−$0.01');
  assert.equal(usd(0.006, { signed: true }), '+$0.01');
  assert.equal(usd(-1234.5, { signed: true }), '−$1,234.50');
  assert.equal(tone(usd(-0.006, { signed: true })), 'down');
  assert.equal(tone(usd(0.006, { signed: true })), 'up');
  assert.equal(pct(-0.0001, { signed: true }), '−0.01%');
});

test('sub-dollar prices use fixed decimals with four significant digits, never an exponent', () => {
  assert.equal(price(0.0000005), '$0.0000005000');
  assert.equal(price(0.5), '$0.5000');
  assert.equal(price(0.0000000015), '$0.000000001500');
  assert.equal(price(1234.5), '$1,234.50');
  for (let exp = -1; exp >= -15; exp--) {
    const p = price(1.234 * 10 ** exp);
    assert.doesNotMatch(p, /e/i, p);
    assert.match(p, /1234$|1235$|1233$/, p);
  }
});
