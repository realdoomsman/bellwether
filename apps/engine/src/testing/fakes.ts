/**
 * Deterministic in-memory implementations of the ports for tests, plus an engine factory over
 * an in-memory database. Every behavior is driven by the mutable `FakeWorld` fields.
 */
import { LAUNCHPAD_IDS, type Address, type Candle, type CandleInterval, type LaunchpadId } from '@stepup/shared';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { createEngine, type Engine } from '../engine.ts';
import { decision, insertToken, type TokenRow } from '../tokens.ts';
import type {
  BuybackResult,
  Fill,
  Integrations,
  Launchpad,
  LaunchpadVerifyResult,
  OpenRequest,
  TxReceiptRef,
  Venue,
  VenueMarket,
  VenuePosition,
} from '../ports.ts';

/** Tuesday 2026-09-22 11:00 America/New_York: regular session. */
export const REGULAR_SESSION = Date.UTC(2026, 8, 22, 15, 0);
/** Saturday 2026-09-26 11:00 America/New_York. */
export const WEEKEND = Date.UTC(2026, 8, 26, 15, 0);

const INTERVAL_MS: Record<CandleInterval, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 };

/** Steady trend with growing volume ending at `lastClose`; `stepPct` per bar (negative for a downtrend). */
export function trendCandles(n: number, opts: { lastClose?: number; stepPct?: number; rangePct?: number; interval?: CandleInterval; end?: number } = {}): Candle[] {
  const { lastClose = 100, stepPct = 0.0005, rangePct = 0.001, interval = '5m', end = REGULAR_SESSION } = opts;
  const out: Candle[] = [];
  let price = lastClose / (1 + stepPct) ** n;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = price * (1 + stepPct);
    const hi = Math.max(o, c) * (1 + rangePct / 2);
    const lo = Math.min(o, c) * (1 - rangePct / 2);
    out.push({ t: end - (n - i) * INTERVAL_MS[interval], o, h: hi, l: lo, c, v: 1000 + i * 20 });
    price = c;
  }
  return out;
}

export function address(n: number): Address {
  return `0x${n.toString(16).padStart(40, '0')}` as Address;
}

let txCounter = 0;
function tx(chain: TxReceiptRef['chain']): TxReceiptRef {
  return { chain, hash: `0x${(++txCounter).toString(16).padStart(64, '0')}` };
}

export interface FakeWorld {
  io: Integrations;
  verify: Map<Address, LaunchpadVerifyResult>;
  deployer: Address;
  claimable: Map<Address, bigint>;
  dexOut: Map<Address, bigint | null>;
  /** Candles returned for every symbol, per interval. */
  candles: Record<CandleInterval, Candle[]>;
  ethUsd: number;
  markets: VenueMarket[];
  venuePaused: boolean;
  freeUsd: number;
  positions: Map<string, VenuePosition>;
  opens: OpenRequest[];
  reduces: { symbol: string; fraction: number }[];
  /** Fill price for reduces; the position's mark when null. */
  nextExitPrice: number | null;
  /** Error thrown by `open` after the position is placed (a fill whose result never reaches the engine). */
  openErrorAfterFill: string | null;
  /** Symbols whose `reduce` throws. */
  failingReduces: Set<string>;
  balances: { rhcEth: number; arbitrumEth: number; arbitrumUsdc: number; venueEquityUsd: number };
}

export function okVerify(deployer: Address, meta: { name?: string; symbol?: string } = {}): LaunchpadVerifyResult {
  return {
    ok: true,
    failure: null,
    detail: 'ok',
    deployer,
    metadata: { name: meta.name ?? 'Test Token', symbol: meta.symbol ?? 'TEST', decimals: 18, totalSupply: 10n ** 27n, image: null },
  };
}

export function createFakeWorld(): FakeWorld {
  const w: FakeWorld = {
    io: undefined as unknown as Integrations,
    verify: new Map(),
    deployer: address(0xde),
    claimable: new Map(),
    dexOut: new Map(),
    candles: {
      '5m': trendCandles(120, { interval: '5m' }),
      '15m': trendCandles(100, { interval: '15m', stepPct: 0.001 }),
      '1h': trendCandles(220, { interval: '1h', stepPct: 0.001 }),
      '1d': trendCandles(60, { interval: '1d', stepPct: 0.001 }),
    },
    ethUsd: 4000,
    markets: [
      { symbol: 'AAPL', venueSymbol: 'xyz:AAPL', maxLeverage: 10, open: true, markPrice: 200 },
      { symbol: 'TSLA', venueSymbol: 'xyz:TSLA', maxLeverage: 10, open: true, markPrice: 400 },
    ],
    venuePaused: false,
    freeUsd: 10_000,
    positions: new Map(),
    opens: [],
    reduces: [],
    nextExitPrice: null,
    openErrorAfterFill: null,
    failingReduces: new Set(),
    balances: { rhcEth: 1, arbitrumEth: 0, arbitrumUsdc: 0, venueEquityUsd: 0 },
  };

  const launchpad = (id: LaunchpadId): Launchpad => ({
    id,
    verify: async (token) => w.verify.get(token) ?? okVerify(w.deployer),
    claimable: async (token) => w.claimable.get(token) ?? 0n,
    claim: async (token) => {
      const amountWei = w.claimable.get(token) ?? 0n;
      if (amountWei <= 0n) return null;
      w.claimable.set(token, 0n);
      return { amountWei, tx: tx('rhc'), tokensBurned: null };
    },
  });

  const venue: Venue = {
    id: 'hyperliquid',
    name: 'Fake venue',
    health: async () => ({ paused: w.venuePaused, reason: w.venuePaused ? 'paused for test' : null }),
    markets: async () => w.markets,
    freeCollateralUsd: async () => w.freeUsd,
    positions: async () => [...w.positions.values()],
    open: async (req): Promise<Fill> => {
      w.opens.push(req);
      const price = w.markets.find((m) => m.symbol === req.symbol)!.markPrice;
      const sizeUsd = req.collateralUsd * req.leverage;
      const feeUsd = sizeUsd * 0.00045;
      w.freeUsd -= req.collateralUsd + feeUsd;
      w.positions.set(req.symbol, {
        symbol: req.symbol,
        side: req.side,
        sizeUsd,
        collateralUsd: req.collateralUsd,
        entryPrice: price,
        markPrice: price,
        leverage: req.leverage,
        unrealizedPnlUsd: 0,
        liquidationPrice: price * (1 - 0.9 / req.leverage),
      });
      if (w.openErrorAfterFill) throw new Error(w.openErrorAfterFill);
      return { symbol: req.symbol, side: req.side, sizeUsd, price, feeUsd, realizedPnlUsd: 0, collateralReleasedUsd: 0, tx: tx('hyperliquid') };
    },
    reduce: async (symbol, fraction): Promise<Fill> => {
      w.reduces.push({ symbol, fraction });
      if (w.failingReduces.has(symbol)) throw new Error(`reduce ${symbol} rejected`);
      const p = w.positions.get(symbol);
      if (!p) throw new Error(`no ${symbol} position`);
      const price = w.nextExitPrice ?? p.markPrice;
      const sizeUsd = p.sizeUsd * fraction;
      const pnl = (sizeUsd * (price - p.entryPrice)) / p.entryPrice;
      const feeUsd = sizeUsd * 0.00045;
      const released = p.collateralUsd * fraction;
      if (fraction >= 1) w.positions.delete(symbol);
      else w.positions.set(symbol, { ...p, sizeUsd: p.sizeUsd - sizeUsd, collateralUsd: p.collateralUsd - released, unrealizedPnlUsd: p.unrealizedPnlUsd * (1 - fraction) });
      w.freeUsd += released + pnl - feeUsd;
      return { symbol, side: p.side, sizeUsd, price, feeUsd, realizedPnlUsd: pnl, collateralReleasedUsd: released, tx: tx('hyperliquid') };
    },
    topUpMargin: async () => ({ movedUsd: 0, txs: [] }),
  };

  w.io = {
    launchpads: Object.fromEntries(LAUNCHPAD_IDS.map((id) => [id, launchpad(id)])) as Record<LaunchpadId, Launchpad>,
    dex: {
      quote: async (token, _amountIn) => {
        const out = w.dexOut.has(token) ? w.dexOut.get(token)! : 10n ** 24n;
        return out === null ? null : { amountOut: out, feeTier: 3000 };
      },
      buyAndBurn: async (token, amountInWei): Promise<BuybackResult> => {
        const out = w.dexOut.get(token) ?? 10n ** 24n;
        return { amountInWei, amountOut: out ?? 0n, swapTx: tx('rhc'), burnTx: tx('rhc') };
      },
      burnHeld: async () => tx('rhc'),
    },
    venues: [venue],
    bridge: {
      quote: async (amountWei) => ({ expectedUsdc: (Number(amountWei) / 1e18) * w.ethUsd, impactPct: 0.001 }),
      ethToUsdc: async (amountWei) => ({ expectedUsdc: (Number(amountWei) / 1e18) * w.ethUsd, tx: tx('rhc') }),
    },
    prices: {
      candles: async (_symbol, interval) => w.candles[interval],
      quote: async (symbol) => {
        const m = w.markets.find((x) => x.symbol === symbol);
        return m ? { price: m.markPrice, change24hPct: 0.01 } : null;
      },
      ethUsd: async () => w.ethUsd,
    },
    tokenData: {
      market: async () => null,
      candles: async () => [],
    },
    wallet: {
      address: address(0x1),
      balances: async () => w.balances,
      tokenBalance: async () => 0n,
    },
    discovery: { scan: async () => ({ candidates: [], toBlock: 0n }) },
  };
  return w;
}

export interface TestEngine {
  engine: Engine;
  world: FakeWorld;
  now: { t: number };
}

export function createTestEngine(env: Record<string, string> = {}, start = REGULAR_SESSION): TestEngine {
  const world = createFakeWorld();
  const now = { t: start };
  const config = loadConfig({ DB_PATH: ':memory:', PROTOCOL_ADDRESS: world.io.wallet.address, ...env });
  const engine = createEngine({ config, db: openDb(':memory:'), io: world.io, clock: () => now.t });
  return { engine, world, now };
}

/** Inserts an active token row directly (bypassing verification). */
export function seedToken(engine: Engine, over: Partial<TokenRow> & { address: Address }): TokenRow {
  const at = engine.clock();
  const row: TokenRow = {
    name: 'Test Token',
    symbol: `T${over.address.slice(-4).toUpperCase()}`,
    image: null,
    launchpad: 'pons',
    status: 'active',
    market: 'AAPL',
    side: 'long',
    strategy: 'balanced',
    maxLeverage: 10,
    deployer: null,
    totalSupply: 10n ** 27n,
    decimals: 18,
    autoDiscovered: false,
    demo: false,
    rejectedReason: null,
    decision: decision('collecting-fees', 'seeded', at),
    createdAt: at,
    updatedAt: at,
    ...over,
  };
  insertToken(engine.db, row);
  return row;
}

let fundCounter = 0;
/** Gives `token` a USDC trading budget of `usd` through a claim + bridge, like the real flow. */
export function fundUsd(engine: Engine, token: Address, usd: number): void {
  const n = ++fundCounter;
  const at = engine.clock();
  const claim = engine.ledger.recordClaim({ token, strategy: 'balanced', amountWei: 10n ** 18n, tx: { chain: 'rhc', hash: `fund-claim-${n}` }, at })!;
  engine.ledger.recordConversion({
    refId: `fund-bridge-${n}`,
    legs: [{ token, gwei: claim.tradingGwei }],
    usdcMicro: Math.round(usd * 1e6),
    tx: { chain: 'rhc', hash: `fund-bridge-${n}` },
    at,
  });
}
