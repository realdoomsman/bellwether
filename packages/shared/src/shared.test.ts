import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEE_SPLIT_BURN_ONLY, FEE_SPLIT_TRADING, feeSplitFor, splitWei } from './fees.ts';
import { marketSession } from './session.ts';
import { effectiveLeverageCap, leverageBounds } from './strategies.ts';

test('splitWei parts always sum to the input, including odd dust', () => {
  for (const amount of [0n, 1n, 7n, 999_999n, 10n ** 18n + 3n]) {
    for (const split of [FEE_SPLIT_TRADING, FEE_SPLIT_BURN_ONLY]) {
      const p = splitWei(amount, split);
      assert.equal(p.trading + p.tokenBuyback + p.protocolBuyback, amount);
      assert.ok(p.trading >= 0n && p.tokenBuyback >= 0n && p.protocolBuyback >= 0n);
    }
  }
  assert.deepEqual(splitWei(10n ** 18n, FEE_SPLIT_TRADING), {
    trading: 600_000_000_000_000_000n,
    protocolBuyback: 150_000_000_000_000_000n,
    tokenBuyback: 250_000_000_000_000_000n,
  });
});

test('burn-only strategy sends nothing to trading', () => {
  assert.equal(feeSplitFor('burn').trading, 0);
  assert.equal(splitWei(12345n, feeSplitFor('burn')).trading, 0n);
});

test('marketSession boundaries in New York time across DST', () => {
  // Summer (EDT, UTC-4)
  assert.equal(marketSession(new Date('2026-07-15T13:29:00Z')), 'pre');
  assert.equal(marketSession(new Date('2026-07-15T13:30:00Z')), 'regular');
  assert.equal(marketSession(new Date('2026-07-15T19:59:00Z')), 'regular');
  assert.equal(marketSession(new Date('2026-07-15T20:00:00Z')), 'post');
  assert.equal(marketSession(new Date('2026-07-16T00:00:00Z')), 'overnight');
  assert.equal(marketSession(new Date('2026-07-15T08:00:00Z')), 'pre');
  // Winter (EST, UTC-5): 14:30Z is the open
  assert.equal(marketSession(new Date('2026-01-14T14:29:00Z')), 'pre');
  assert.equal(marketSession(new Date('2026-01-14T14:30:00Z')), 'regular');
  // Weekend gap: Fri 20:00 ET → Sun 20:00 ET
  assert.equal(marketSession(new Date('2026-07-18T00:30:00Z')), 'weekend'); // Fri 20:30 ET
  assert.equal(marketSession(new Date('2026-07-18T15:00:00Z')), 'weekend'); // Sat
  assert.equal(marketSession(new Date('2026-07-19T23:59:00Z')), 'weekend'); // Sun 19:59 ET
  assert.equal(marketSession(new Date('2026-07-20T00:01:00Z')), 'overnight'); // Sun 20:01 ET
});

test('effective leverage is the strictest cap and zero for burn-only', () => {
  assert.equal(effectiveLeverageCap('degen', 50, 20), 20);
  assert.equal(effectiveLeverageCap('degen', 8, 20), 8);
  assert.equal(effectiveLeverageCap('steady', 50, 20), 5);
  assert.equal(effectiveLeverageCap('burn', 50, 20), 0);
});

test('leverage bounds are unavailable, not inverted, when the venue caps a market below the strategy minimum', () => {
  assert.deepEqual(leverageBounds('degen', 20), { min: 5, max: 20 });
  assert.deepEqual(leverageBounds('degen', 5), { min: 5, max: 5 });
  assert.equal(leverageBounds('degen', 3), 'unavailable');
  assert.deepEqual(leverageBounds('steady', 3), { min: 2, max: 3 });
  assert.deepEqual(leverageBounds('burn', 1), { min: 0, max: 0 });
});
