import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEE_SPLIT_BURN_ONLY, FEE_SPLIT_TRADING, feeSplitFor, splitWei } from './fees.ts';
import { marketSession, nyseDay } from './session.ts';
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

test('NYSE holidays and early closes match the published 2026 and 2027 calendars', () => {
  const closed = (year: number) => {
    const out: string[] = [];
    for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86_400_000) {
      const d = new Date(t);
      const kind = nyseDay(year, d.getUTCMonth() + 1, d.getUTCDate());
      if (kind) out.push(`${d.toISOString().slice(5, 10)} ${kind}`);
    }
    return out;
  };
  // https://www.nyse.com/markets/hours-calendars
  assert.deepEqual(closed(2026), [
    '01-01 closed', '01-19 closed', '02-16 closed', '04-03 closed', '05-25 closed', '06-19 closed',
    '07-03 closed', '09-07 closed', '11-26 closed', '11-27 early', '12-24 early', '12-25 closed',
  ]);
  assert.deepEqual(closed(2027), [
    '01-01 closed', '01-18 closed', '02-15 closed', '03-26 closed', '05-31 closed', '06-18 closed',
    '07-05 closed', '09-06 closed', '11-25 closed', '11-26 early', '12-24 closed',
  ]);
  // A Saturday New Year's Day leaves the Friday before open.
  assert.equal(nyseDay(2027, 12, 31), null);
});

test('holidays and early closes shape the session', () => {
  assert.equal(marketSession(new Date('2026-11-26T01:30:00Z')), 'overnight'); // Wed 20:30 ET, the evening before
  assert.equal(marketSession(new Date('2026-11-26T16:00:00Z')), 'holiday'); // Thanksgiving 11:00 ET
  assert.equal(marketSession(new Date('2026-11-27T04:00:00Z')), 'holiday'); // Thanksgiving 23:00 ET
  assert.equal(marketSession(new Date('2026-11-27T17:59:00Z')), 'regular'); // Black Friday 12:59 ET
  assert.equal(marketSession(new Date('2026-11-27T18:00:00Z')), 'post'); // 13:00 ET early close
  assert.equal(marketSession(new Date('2026-11-27T22:00:00Z')), 'overnight'); // 17:00 ET
  assert.equal(marketSession(new Date('2026-09-06T23:00:00Z')), 'weekend'); // Sun 19:00 ET before Labor Day
  assert.equal(marketSession(new Date('2026-09-07T01:00:00Z')), 'overnight'); // Sun 21:00 ET
  assert.equal(marketSession(new Date('2026-09-07T14:00:00Z')), 'holiday'); // Labor Day 10:00 ET
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
