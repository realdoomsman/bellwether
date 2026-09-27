/**
 * GeckoTerminal market data for Robinhood Chain tokens (free API, ~30 req/min: cache hard).
 * Tokens not yet trading on an indexed pool return null / no candles.
 */
import type { Address } from 'viem';
import type { Candle, CandleInterval } from '@bellwether/shared';
import type { NetworkConfig, TokenData, TokenMarketData } from '../ports.ts';
import { HttpError, fetchJson, TtlCache } from './http.ts';

const TOKEN_TTL_MS = 60_000;
const OHLCV_TTL_MS = 60_000;
const MAX_OHLCV_LIMIT = 1000;

const TIMEFRAME: Record<CandleInterval, { timeframe: 'minute' | 'hour' | 'day'; aggregate: number }> = {
  '5m': { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h': { timeframe: 'hour', aggregate: 1 },
  '1d': { timeframe: 'day', aggregate: 1 },
};

interface GtToken {
  data: {
    attributes: { price_usd: string | null; fdv_usd: string | null; total_reserve_in_usd: string | null; volume_usd: { h24: string | null } };
    relationships: { top_pools: { data: { id: string }[] } };
  };
  included?: {
    id: string;
    type: string;
    attributes: { price_change_percentage?: { h24?: string | null } };
    relationships?: { base_token?: { data: { id: string } } };
  }[];
}

interface TokenSnapshot {
  market: TokenMarketData;
  /** Most liquid pool address, if any. */
  pool: string | null;
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function createTokenData(net: NetworkConfig): TokenData {
  const base = `${net.geckoterminalUrl}/networks/${net.geckoterminalNetwork}`;
  const idPrefix = `${net.geckoterminalNetwork}_`;
  const snapshots = new TtlCache<TokenSnapshot | null>(TOKEN_TTL_MS);
  const ohlcv = new TtlCache<Candle[]>(OHLCV_TTL_MS);

  function snapshot(token: Address): Promise<TokenSnapshot | null> {
    const addr = token.toLowerCase();
    return snapshots.get(addr, async () => {
      let json: GtToken;
      try {
        json = await fetchJson<GtToken>('GeckoTerminal token', `${base}/tokens/${addr}?include=top_pools`);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null; // not indexed yet
        throw err;
      }
      const a = json.data.attributes;
      const poolId = json.data.relationships.top_pools.data[0]?.id ?? null;
      const pool = poolId ? json.included?.find((i) => i.id === poolId) : undefined;
      // Pool price change refers to the pool's base token; only use it when that is our token.
      const isBase = pool?.relationships?.base_token?.data.id === `${idPrefix}${addr}`;
      const change = isBase ? num(pool?.attributes.price_change_percentage?.h24) : null;
      return {
        market: {
          priceUsd: num(a.price_usd),
          change24hPct: change === null ? null : change / 100,
          fdvUsd: num(a.fdv_usd),
          volume24hUsd: num(a.volume_usd.h24),
          liquidityUsd: num(a.total_reserve_in_usd),
        },
        pool: poolId?.startsWith(idPrefix) ? poolId.slice(idPrefix.length) : poolId,
      };
    });
  }

  return {
    async market(token) {
      return (await snapshot(token))?.market ?? null;
    },

    async candles(token, interval, limit) {
      const pool = (await snapshot(token))?.pool;
      if (!pool) return [];
      const { timeframe, aggregate } = TIMEFRAME[interval];
      const n = Math.min(Math.max(1, Math.floor(limit)), MAX_OHLCV_LIMIT);
      const addr = token.toLowerCase();
      return ohlcv.get(`${pool}:${addr}:${interval}:${n}`, async () => {
        const json = await fetchJson<{ data: { attributes: { ohlcv_list: [number, number, number, number, number, number][] } } }>(
          'GeckoTerminal OHLCV',
          `${base}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${n}&currency=usd&token=${addr}`,
        );
        // Newest first from the API; ports want newest last.
        return json.data.attributes.ohlcv_list.map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v })).reverse();
      });
    },
  };
}
