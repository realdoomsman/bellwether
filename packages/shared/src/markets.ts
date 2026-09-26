export interface StockMarket {
  symbol: string;
  name: string;
  sector: string;
}

/** Candidate underlyings. Which ones are tradable right now is decided by the active venue at runtime. */
export const STOCK_MARKETS: readonly StockMarket[] = [
  { symbol: 'AAPL', name: 'Apple', sector: 'Tech' },
  { symbol: 'TSLA', name: 'Tesla', sector: 'Auto' },
  { symbol: 'NVDA', name: 'Nvidia', sector: 'Semis' },
  { symbol: 'MSFT', name: 'Microsoft', sector: 'Tech' },
  { symbol: 'GOOGL', name: 'Alphabet', sector: 'Tech' },
  { symbol: 'AMZN', name: 'Amazon', sector: 'Retail' },
  { symbol: 'META', name: 'Meta', sector: 'Tech' },
  { symbol: 'HOOD', name: 'Robinhood', sector: 'Fintech' },
  { symbol: 'COIN', name: 'Coinbase', sector: 'Fintech' },
  { symbol: 'MSTR', name: 'Strategy', sector: 'Fintech' },
  { symbol: 'NFLX', name: 'Netflix', sector: 'Media' },
  { symbol: 'AMD', name: 'AMD', sector: 'Semis' },
  { symbol: 'PLTR', name: 'Palantir', sector: 'Software' },
  { symbol: 'AVGO', name: 'Broadcom', sector: 'Semis' },
];

const BY_SYMBOL: Record<string, StockMarket> = Object.fromEntries(STOCK_MARKETS.map((m) => [m.symbol, m]));

export function isStockSymbol(v: unknown): v is string {
  return typeof v === 'string' && Object.hasOwn(BY_SYMBOL, v.toUpperCase());
}
