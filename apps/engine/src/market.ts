/** Cached read-side market data: venue routing, venue markets, stock quotes, signals, token prices. */
import { isStockSymbol, marketSession, type Address, type VenueId, type VenueStatus } from '@bellwether/shared';
import { SerialQueue, TtlCache } from './cache.ts';
import type { Integrations, TokenMarketData, Venue, VenueMarket } from './ports.ts';
import { computeSignal, type Signal } from './signal.ts';

interface VenueHealth {
  venue: Venue;
  paused: boolean;
  reason: string | null;
  maxLeverage: number;
}

export class MarketData {
  readonly #io: Integrations;
  readonly #clock: () => number;
  readonly #health: TtlCache<VenueHealth[]>;
  readonly #markets: TtlCache<VenueMarket[]>;
  readonly #quotes: TtlCache<{ price: number; change24hPct: number } | null>;
  readonly #signals: TtlCache<Signal>;
  readonly #eth: TtlCache<number>;
  readonly #tokens: TtlCache<TokenMarketData | null>;
  readonly #background = new SerialQueue();

  constructor(io: Integrations, clock: () => number) {
    this.#io = io;
    this.#clock = clock;
    this.#health = new TtlCache(30_000, clock);
    this.#markets = new TtlCache(30_000, clock);
    this.#quotes = new TtlCache(30_000, clock);
    this.#signals = new TtlCache(60_000, clock);
    this.#eth = new TtlCache(60_000, clock);
    this.#tokens = new TtlCache(60_000, clock);
  }

  #venueHealth(): Promise<VenueHealth[]> {
    return this.#health.get('all', () =>
      Promise.all(
        this.#io.venues.map(async (venue) => {
          try {
            const [h, markets] = await Promise.all([venue.health(), this.#marketsOf(venue)]);
            return { venue, paused: h.paused, reason: h.reason, maxLeverage: stockMaxLeverage(markets) };
          } catch (err) {
            return { venue, paused: true, reason: `health check failed: ${err instanceof Error ? err.message : String(err)}`, maxLeverage: 0 };
          }
        }),
      ),
    );
  }

  #marketsOf(venue: Venue): Promise<VenueMarket[]> {
    return this.#markets.get(venue.id, () => venue.markets());
  }

  /** First healthy venue in preference order, or null when every venue is paused/unreachable. */
  async activeVenue(): Promise<Venue | null> {
    return (await this.#venueHealth()).find((h) => !h.paused)?.venue ?? null;
  }

  async venueStatus(): Promise<{ active: VenueId | null; venues: VenueStatus[] }> {
    const health = await this.#venueHealth();
    const active = health.find((h) => !h.paused)?.venue.id ?? null;
    return {
      active,
      venues: health.map((h) => ({
        id: h.venue.id,
        name: h.venue.name,
        active: h.venue.id === active,
        paused: h.paused,
        pausedReason: h.reason,
        maxLeverage: h.maxLeverage,
      })),
    };
  }

  /** Markets of the active venue; empty when no venue is available. */
  async venueMarkets(): Promise<VenueMarket[]> {
    const venue = await this.activeVenue();
    return venue ? this.#marketsOf(venue) : [];
  }

  async signal(symbol: string): Promise<Signal> {
    return this.#signals.get(symbol, async () => {
      const [fast, mid, slow] = await Promise.all([
        this.#io.prices.candles(symbol, '5m', 120),
        this.#io.prices.candles(symbol, '15m', 100),
        this.#io.prices.candles(symbol, '1h', 220),
      ]);
      return computeSignal({ fast, mid, slow, session: marketSession(new Date(this.#clock())) });
    });
  }

  quote(symbol: string): Promise<{ price: number; change24hPct: number } | null> {
    return this.#quotes.get(symbol, () => this.#io.prices.quote(symbol));
  }

  ethUsd(): Promise<number> {
    return this.#eth.get('eth', async () => {
      const p = await this.#io.prices.ethUsd();
      if (!(p > 0)) throw new Error(`invalid ETH/USD price ${p}`);
      return p;
    });
  }

  peekEthUsd(): number | undefined {
    return this.#eth.peek('eth');
  }

  tokenMarket(token: Address): Promise<TokenMarketData | null> {
    return this.#tokens.get(token, () => this.#io.tokenData.market(token));
  }

  /** Cached token market data; stale entries refresh one at a time in the background so list views never block. */
  peekTokenMarket(token: Address): TokenMarketData | null {
    if (!this.#tokens.isFresh(token)) this.#background.enqueue(`token:${token}`, () => this.tokenMarket(token));
    return this.#tokens.peek(token) ?? null;
  }

  /** Cached signal; stale entries recompute in the background. */
  peekSignalRefreshing(symbol: string): Signal | undefined {
    if (!this.#signals.isFresh(symbol)) this.#background.enqueue(`signal:${symbol}`, () => this.signal(symbol));
    return this.#signals.peek(symbol);
  }
}

/** Highest leverage among the venue's listed stock markets (venues also list indices, FX and commodities). */
export function stockMaxLeverage(markets: readonly VenueMarket[]): number {
  return markets.reduce((max, m) => (isStockSymbol(m.symbol) ? Math.max(max, m.maxLeverage) : max), 0);
}
