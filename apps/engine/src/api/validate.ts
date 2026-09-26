/** Request validation helpers; each throws an ApiFailure with a stable code. */
import {
  STRATEGIES,
  isLaunchpadId,
  isStockSymbol,
  isStrategyId,
  type Address,
  type CandleInterval,
  type LaunchpadId,
  type Side,
  type StrategyId,
} from '@floor/shared';
import type { Engine } from '../engine.ts';
import type { VenueMarket } from '../ports.ts';
import { leverageBounds } from '../registration.ts';
import { normalizeAddress } from '../tokens.ts';
import { ApiFailure } from './errors.ts';

export const CANDLE_INTERVALS: readonly CandleInterval[] = ['5m', '15m', '1h', '1d'];

export function requireAddress(v: unknown, field = 'address'): Address {
  const a = normalizeAddress(v);
  if (!a) throw new ApiFailure(400, 'invalid_address', `${field} must be a 0x-prefixed EVM address`);
  return a;
}

export function requireLaunchpad(v: unknown): LaunchpadId {
  if (!isLaunchpadId(v)) throw new ApiFailure(400, 'unsupported_launchpad', `Unsupported launchpad: ${String(v)}`);
  return v;
}

export function requireStrategy(v: unknown): StrategyId {
  if (!isStrategyId(v)) throw new ApiFailure(400, 'invalid_strategy', `Unknown strategy: ${String(v)}`);
  return v;
}

export function requireSide(v: unknown): Side {
  if (v === 'short') throw new ApiFailure(400, 'short_unavailable', 'Short pools are not available yet; use long');
  if (v !== 'long') throw new ApiFailure(400, 'invalid_body', 'side must be "long"');
  return v;
}

/** The market must be a known stock and listed on the active venue. */
export async function requireMarket(engine: Engine, v: unknown): Promise<VenueMarket> {
  if (!isStockSymbol(v)) throw new ApiFailure(400, 'unsupported_market', `Unsupported market: ${String(v)}`);
  const symbol = v.toUpperCase();
  let markets: VenueMarket[];
  try {
    markets = await engine.market.venueMarkets();
  } catch {
    throw new ApiFailure(502, 'rpc_error', 'Could not load venue markets; try again');
  }
  const m = markets.find((x) => x.symbol === symbol);
  if (!m) throw new ApiFailure(400, 'unsupported_market', `${symbol} is not available on the active venue`, { market: symbol });
  return m;
}

/** Trading strategies need an integer inside the strategy/venue bounds; burn-only stores 0. */
export function requireLeverage(v: unknown, strategy: StrategyId, venueCap: number): number {
  if (!STRATEGIES[strategy].trades) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ApiFailure(400, 'invalid_leverage', 'maxLeverage must be 0 for burn-only', { min: 0, max: 0 });
    return 0;
  }
  const b = leverageBounds(strategy, venueCap);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < b.min || v > b.max) {
    throw new ApiFailure(400, 'invalid_leverage', `maxLeverage must be an integer between ${b.min} and ${b.max}`, { min: b.min, max: b.max });
  }
  return v;
}

export function parseInterval(v: string | undefined, def: CandleInterval): CandleInterval {
  if (v === undefined) return def;
  if (!(CANDLE_INTERVALS as readonly string[]).includes(v)) {
    throw new ApiFailure(400, 'invalid_interval', `interval must be one of ${CANDLE_INTERVALS.join(', ')}`);
  }
  return v as CandleInterval;
}

export function parseIntParam(v: string | undefined, name: string, def: number, min: number, max: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiFailure(400, 'invalid_query', `${name} must be an integer between ${min} and ${max}`);
  return n;
}

export async function jsonBody(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiFailure(400, 'invalid_body', 'Body must be valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiFailure(400, 'invalid_body', 'Body must be a JSON object');
  return body as Record<string, unknown>;
}
