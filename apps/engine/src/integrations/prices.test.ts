import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { HlInfo } from './hyperliquid/info.ts';
import { createPriceFeed } from './prices.ts';

const MIN = 60_000;

/** Hyperliquid down; Yahoo serves AAPL 5m bars whose newest starts `ageMs` ago, with the regular-session price that old. */
function stubYahooOnly(t: TestContext, ageMs: number) {
  const last = Date.now() - ageMs;
  const ts = [3, 2, 1, 0].map((k) => Math.floor((last - k * 5 * MIN) / 1000));
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.startsWith('https://api.hyperliquid.xyz/')) return new Response('upstream down', { status: 502 });
    if (url.includes('finance.yahoo.com')) {
      const n = ts.length;
      return Response.json({
        chart: {
          result: [
            {
              meta: { regularMarketPrice: 333.69, chartPreviousClose: 330, regularMarketTime: ts.at(-1) },
              timestamp: ts,
              indicators: { quote: [{ open: Array(n).fill(333), high: Array(n).fill(334), low: Array(n).fill(332), close: Array(n).fill(333.69), volume: Array(n).fill(1000) }] },
            },
          ],
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return createPriceFeed(new HlInfo('https://api.hyperliquid.xyz'), 'xyz');
}

test('outside the hours Yahoo covers (its data is a weekend old), the fallback refuses instead of serving stale prices', async (t) => {
  // Friday's close seen on Sunday: xyz has traded for ~40 hours since.
  const feed = stubYahooOnly(t, 40 * 60 * MIN);
  await assert.rejects(feed.candles('AAPL', '5m', 3), /Yahoo AAPL 5m candles: stale/);
  await assert.rejects(feed.quote('AAPL'), /Yahoo AAPL quote: stale/);
});

test('while Yahoo is current, it still stands in for Hyperliquid', async (t) => {
  const feed = stubYahooOnly(t, 2 * MIN);
  assert.equal((await feed.candles('AAPL', '5m', 3)).length, 3);
  assert.deepEqual(await feed.quote('AAPL'), { price: 333.69, change24hPct: 333.69 / 330 - 1 });
});
