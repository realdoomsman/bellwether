/**
 * Paper perp venue: real Hyperliquid market metadata and prices, simulated isolated-margin
 * fills with taker fee + slippage, persistent in SQLite. Liquidated positions disappear from
 * positions() exactly like on a real venue.
 */
import type { Side } from '@floor/shared';
import { kvGet, kvSet, type Db } from '../db.ts';
import type { Fill, OpenRequest, PriceFeed, TxReceiptRef, Venue, VenueMarket, VenuePosition } from '../ports.ts';
import { paperRef } from './refs.ts';

export const PAPER_TAKER_FEE = 0.00045;
export const PAPER_SLIPPAGE = 0.0002;
const STATE_KEY = 'paper.venue';

export interface PaperVenueState {
  /** USDC in venue margin, not in a position. */
  freeUsd: number;
  /** USDC landed on Arbitrum, not yet deposited to the venue. */
  arbitrumUsdc: number;
}

interface PaperPositionRow {
  symbol: string;
  side: Side;
  size_usd: number;
  collateral_usd: number;
  entry_price: number;
  leverage: number;
  liquidation_price: number;
  opened_at: number;
}

export function paperVenueState(db: Db): PaperVenueState {
  return kvGet<PaperVenueState>(db, STATE_KEY) ?? { freeUsd: 0, arbitrumUsdc: 0 };
}

export function setPaperVenueState(db: Db, s: PaperVenueState): void {
  kvSet(db, STATE_KEY, s);
}

/**
 * Isolated-margin liquidation price: equity (collateral + PnL) falls to maintenance margin
 * `mmr × notional`. HL maintenance margin is half the initial margin at max leverage.
 */
export function liquidationPrice(side: Side, entry: number, sizeUsd: number, collateralUsd: number, maxLeverage: number): number {
  const mmr = 1 / (2 * maxLeverage);
  const qty = sizeUsd / entry;
  return side === 'long' ? Math.max(0, (entry - collateralUsd / qty) / (1 - mmr)) : (entry + collateralUsd / qty) / (1 + mmr);
}

export function createPaperVenue(p: { db: Db; market: Venue; prices: PriceFeed; clock: () => number }): Venue {
  const { db, market, prices, clock } = p;

  const mark = async (symbol: string): Promise<number> => {
    const q = await prices.quote(symbol);
    if (q && q.price > 0) return q.price;
    const m = (await market.markets()).find((x) => x.symbol === symbol);
    if (m && m.markPrice > 0) return m.markPrice;
    throw new Error(`paper venue: no price for ${symbol}`);
  };
  const meta = async (symbol: string): Promise<VenueMarket> => {
    const m = (await market.markets()).find((x) => x.symbol === symbol);
    if (!m) throw new Error(`paper venue: ${symbol} is not listed`);
    return m;
  };
  const row = (symbol: string) => db.get<PaperPositionRow>('SELECT * FROM paper_positions WHERE symbol = ?', [symbol]);
  const tx = (): TxReceiptRef => ({ chain: 'hyperliquid', hash: paperRef() });

  return {
    id: 'paper',
    name: 'Paper venue (Hyperliquid prices)',
    health: () => market.health(),
    markets: () => market.markets(),
    freeCollateralUsd: async () => paperVenueState(db).freeUsd,

    async positions(): Promise<VenuePosition[]> {
      const out: VenuePosition[] = [];
      for (const r of db.all<PaperPositionRow>('SELECT * FROM paper_positions ORDER BY symbol')) {
        const price = await mark(r.symbol);
        const dir = r.side === 'long' ? 1 : -1;
        if (dir * (price - r.liquidation_price) <= 0) {
          // Liquidated: the isolated collateral is gone.
          db.run('DELETE FROM paper_positions WHERE symbol = ?', [r.symbol]);
          continue;
        }
        out.push({
          symbol: r.symbol,
          side: r.side,
          sizeUsd: r.size_usd,
          collateralUsd: r.collateral_usd,
          entryPrice: r.entry_price,
          markPrice: price,
          leverage: r.leverage,
          unrealizedPnlUsd: (r.size_usd * dir * (price - r.entry_price)) / r.entry_price,
          liquidationPrice: r.liquidation_price,
        });
      }
      return out;
    },

    async open(req: OpenRequest): Promise<Fill> {
      const m = await meta(req.symbol);
      if (!m.open) throw new Error(`paper venue: ${req.symbol} is not trading right now`);
      if (req.leverage > m.maxLeverage) throw new Error(`paper venue: leverage ${req.leverage} > max ${m.maxLeverage}`);
      if (row(req.symbol)) throw new Error(`paper venue: ${req.symbol} already has a position`);
      const dir = req.side === 'long' ? 1 : -1;
      const price = (await mark(req.symbol)) * (1 + dir * PAPER_SLIPPAGE);
      const sizeUsd = req.collateralUsd * req.leverage;
      const feeUsd = sizeUsd * PAPER_TAKER_FEE;
      const state = paperVenueState(db);
      if (state.freeUsd + 1e-9 < req.collateralUsd + feeUsd) {
        throw new Error(`paper venue: free margin $${state.freeUsd.toFixed(2)} < $${(req.collateralUsd + feeUsd).toFixed(2)}`);
      }
      db.transaction(() => {
        db.run(
          `INSERT INTO paper_positions (symbol, side, size_usd, collateral_usd, entry_price, leverage, liquidation_price, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.symbol, req.side, sizeUsd, req.collateralUsd, price, req.leverage, liquidationPrice(req.side, price, sizeUsd, req.collateralUsd, m.maxLeverage), clock()],
        );
        setPaperVenueState(db, { ...state, freeUsd: Math.max(0, state.freeUsd - req.collateralUsd - feeUsd) });
      });
      return { symbol: req.symbol, side: req.side, sizeUsd, price, feeUsd, realizedPnlUsd: 0, collateralReleasedUsd: 0, tx: tx() };
    },

    async reduce(symbol: string, fraction: number): Promise<Fill> {
      const r = row(symbol);
      if (!r) throw new Error(`paper venue: no ${symbol} position`);
      const f = Math.min(1, Math.max(0, fraction));
      const dir = r.side === 'long' ? 1 : -1;
      const price = (await mark(symbol)) * (1 - dir * PAPER_SLIPPAGE);
      const sizeUsd = r.size_usd * f;
      const pnl = (sizeUsd * dir * (price - r.entry_price)) / r.entry_price;
      const feeUsd = sizeUsd * PAPER_TAKER_FEE;
      const released = r.collateral_usd * f;
      const state = paperVenueState(db);
      db.transaction(() => {
        if (f >= 1) db.run('DELETE FROM paper_positions WHERE symbol = ?', [symbol]);
        else db.run('UPDATE paper_positions SET size_usd = ?, collateral_usd = ? WHERE symbol = ?', [r.size_usd - sizeUsd, r.collateral_usd - released, symbol]);
        setPaperVenueState(db, { ...state, freeUsd: state.freeUsd + Math.max(0, released + pnl - feeUsd) });
      });
      return { symbol, side: r.side, sizeUsd, price, feeUsd, realizedPnlUsd: pnl, collateralReleasedUsd: released, tx: tx() };
    },

    async topUpMargin() {
      const state = paperVenueState(db);
      if (state.arbitrumUsdc <= 0) return { movedUsd: 0, txs: [] };
      setPaperVenueState(db, { freeUsd: state.freeUsd + state.arbitrumUsdc, arbitrumUsdc: 0 });
      return { movedUsd: state.arbitrumUsdc, txs: [{ chain: 'arbitrum' as const, hash: paperRef() }] };
    },
  };
}

/** Margin equity of the paper venue: free margin plus each position's collateral and PnL. */
export async function paperVenueEquity(db: Db, venue: Venue): Promise<number> {
  const positions = await venue.positions();
  return paperVenueState(db).freeUsd + positions.reduce((s, p) => s + p.collateralUsd + p.unrealizedPnlUsd, 0);
}
