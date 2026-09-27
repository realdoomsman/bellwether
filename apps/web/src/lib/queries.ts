import type { CandleInterval, LeaderboardBy } from '@bellwether/shared';
import { api } from './api';
import { TRADES_KEY, useStreamRefresh } from './stream';
import { useApi } from './useApi';

/** Resource hooks. Keys are shared app-wide, so every consumer of a key sees the same data. */

export function useStatus() {
  return useApi('status', api.status, { refreshMs: useStreamRefresh() });
}

export function useStats() {
  return useApi('stats', api.stats, { refreshMs: useStreamRefresh() });
}

export function usePositions() {
  return useApi('positions', api.positions, { refreshMs: useStreamRefresh() });
}

export function useActivity() {
  return useApi('activity', (s) => api.activity({ limit: 50 }, s), { refreshMs: useStreamRefresh() });
}

export function useConfig() {
  return useApi('config', api.config, { refreshMs: 300_000, maxAgeMs: 60_000 });
}

export function useMarkets() {
  return useApi('markets', api.markets, { refreshMs: 15_000 });
}

export function useTokens() {
  return useApi('tokens', api.tokens, { refreshMs: 30_000 });
}

export function useToken(address: string) {
  return useApi(`token:${address.toLowerCase()}`, (s) => api.token(address, s), { refreshMs: 30_000 });
}

/** Pooled trades across all markets; refetched by the stream whenever a trade lands (see stream.ts). */
export function useTrades() {
  return useApi(TRADES_KEY, (s) => api.trades(50, s), { refreshMs: useStreamRefresh() });
}

export function useLeaderboard(by: LeaderboardBy) {
  return useApi(`leaderboard:${by}`, (s) => api.leaderboard(by, s), { refreshMs: 60_000 });
}

export function useProof() {
  return useApi('proof', api.proof, { refreshMs: 60_000 });
}

export function useMarketCandles(symbol: string | null, interval: CandleInterval) {
  return useApi(symbol ? `candles:${symbol}:${interval}` : null, (s) => api.marketCandles(symbol ?? '', interval, s), {
    refreshMs: 60_000,
  });
}

export function useTokenCandles(address: string, interval: CandleInterval) {
  return useApi(`token-candles:${address.toLowerCase()}:${interval}`, (s) => api.tokenCandles(address, interval, s), {
    refreshMs: 60_000,
  });
}
