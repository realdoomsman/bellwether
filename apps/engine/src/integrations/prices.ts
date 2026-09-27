/**
 * Market data. Stocks: Hyperliquid builder-dex candles/marks (the prices we actually trade),
 * Yahoo chart API as fallback. ETH/USD: Hyperliquid mids, Coinbase as fallback.
 */
import type { Candle, CandleInterval } from '@bellwether/shared';
import type { PriceFeed } from '../ports.ts';
import { log } from '../log.ts';
import { shortError } from './errors.ts';
import { fetchJson, TtlCache } from './http.ts';
import type { HlInfo } from './hyperliquid/info.ts';

const CANDLE_TTL_MS = 30_000;
const ETH_TTL_MS = 30_000;
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_HEADERS = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)' };
const COINBASE_ETH_USD = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';

const INTERVAL_MS: Record<CandleInterval, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 };
/**
 * Candle requests span twice the bars asked for plus a long weekend, then keep the newest `limit`: equity
 * perps pause (Fri 20:00 → Sun 20:00 ET, halts), so an exact `limit × interval` window comes back short
 * and indicators that need a full history (EMA200) silently drop out.
 */
const CANDLE_GAP_ALLOWANCE_MS = 3 * 86_400_000;
/** Yahoo interval + the smallest range holding enough bars. */
const YAHOO_RANGE: Record<CandleInterval, { interval: string; range: string }> = {
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '1mo' },
  '1h': { interval: '60m', range: '6mo' },
  '1d': { interval: '1d', range: '2y' },
};

interface YahooChart {
  chart: {
    result:
      | {
          meta: { regularMarketPrice?: number; chartPreviousClose?: number };
          timestamp?: number[];
          indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] };
        }[]
      | null;
  };
}

export function createPriceFeed(info: HlInfo, dex: string): PriceFeed {
  const candleCache = new TtlCache<Candle[]>(CANDLE_TTL_MS);
  const ethCache = new TtlCache<number>(ETH_TTL_MS);

  async function hlCandles(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
    const end = Date.now();
    const raw = await info.candles(`${dex}:${symbol}`, interval, end - 2 * limit * INTERVAL_MS[interval] - CANDLE_GAP_ALLOWANCE_MS, end);
    return raw.map((c) => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }));
  }

  function yahooChart(symbol: string, interval: string, range: string): Promise<YahooChart> {
    const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=true`;
    return fetchJson<YahooChart>(`Yahoo chart ${symbol}`, url, { headers: YAHOO_HEADERS });
  }

  async function yahooCandles(symbol: string, interval: CandleInterval): Promise<Candle[]> {
    const { interval: yi, range } = YAHOO_RANGE[interval];
    const result = (await yahooChart(symbol, yi, range)).chart.result?.[0];
    const q = result?.indicators.quote[0];
    if (!result?.timestamp || !q) return [];
    const out: Candle[] = [];
    result.timestamp.forEach((ts, i) => {
      const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
      if (o == null || h == null || l == null || c == null) return; // empty bucket (halt, gap)
      out.push({ t: ts * 1000, o, h, l, c, v: q.volume[i] ?? 0 });
    });
    return out;
  }

  return {
    candles(symbol, interval, limit) {
      const sym = symbol.toUpperCase();
      return candleCache.get(`${sym}:${interval}:${limit}`, async () => {
        try {
          const hl = await hlCandles(sym, interval, limit);
          if (hl.length > 0) return hl.slice(-limit);
        } catch (err) {
          log.warn('Hyperliquid candles failed; falling back to Yahoo', { symbol: sym, interval, error: shortError(err) });
        }
        return (await yahooCandles(sym, interval)).slice(-limit);
      });
    },

    async quote(symbol) {
      const sym = symbol.toUpperCase();
      try {
        const a = (await info.dex(dex)).assets.find((x) => x.symbol === sym && !x.isDelisted);
        if (a && a.markPx > 0) return { price: a.markPx, change24hPct: a.prevDayPx > 0 ? a.markPx / a.prevDayPx - 1 : 0 };
      } catch (err) {
        log.warn('Hyperliquid quote failed; falling back to Yahoo', { symbol: sym, error: shortError(err) });
      }
      const meta = (await yahooChart(sym, '1d', '5d')).chart.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prev = meta?.chartPreviousClose;
      if (!price) return null;
      return { price, change24hPct: prev ? price / prev - 1 : 0 };
    },

    ethUsd() {
      return ethCache.get('eth', async () => {
        let hlError: string;
        try {
          const px = Number((await info.allMids()).ETH);
          if (px > 0) return px;
          hlError = 'no ETH mid';
        } catch (err) {
          hlError = shortError(err);
        }
        try {
          const cb = await fetchJson<{ data: { amount: string } }>('Coinbase ETH-USD', COINBASE_ETH_USD);
          const px = Number(cb.data.amount);
          if (px > 0) return px;
          throw new Error('Coinbase returned no price');
        } catch (err) {
          throw new Error(`ETH/USD unavailable (hyperliquid: ${hlError}; ${shortError(err)})`);
        }
      });
    },
  };
}
