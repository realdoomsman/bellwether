import type { CandleInterval } from '@bellwether/shared';
import { useState } from 'react';
import { CandleChart } from '../../components/CandleChart';
import { Empty, ErrorNotice, Loading } from '../../components/DataState';
import { Segmented } from '../../components/Segmented';
import { useMarketCandles, useTokenCandles } from '../../lib/queries';

const INTERVALS = [
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '1d', label: '1d' },
] as const satisfies readonly { value: CandleInterval; label: string }[];

function MarketChart({ symbol, interval }: { symbol: string; interval: CandleInterval }) {
  const q = useMarketCandles(symbol, interval);
  if (!q.data) return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what={`${symbol} chart`} compact /> : <Loading label={`${symbol} chart`} height={300} />;
  if (q.data.candles.length === 0) return <Empty title="No candles for this interval">The venue returned no price history for {symbol} at {interval}.</Empty>;
  return <CandleChart candles={q.data.candles} label={`${symbol} perp, ${interval} candles`} height={300} />;
}

function TokenChart({ address, symbol, interval }: { address: string; symbol: string; interval: CandleInterval }) {
  const q = useTokenCandles(address, interval);
  if (!q.data) return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what={`$${symbol} chart`} compact /> : <Loading label={`$${symbol} chart`} height={300} />;
  if (q.data.candles.length === 0) {
    return (
      <Empty title="No DEX chart yet">
        ${symbol} has no Uniswap trading history at this interval. Tokens trade on the launchpad’s bonding curve until they graduate to a pool.
      </Empty>
    );
  }
  return <CandleChart candles={q.data.candles} label={`$${symbol} on Uniswap, ${interval} candles`} height={300} />;
}

export function Charts({ address, symbol, market }: { address: string; symbol: string; market: string }) {
  const [interval, setCandleInterval] = useState<CandleInterval>('15m');
  return (
    <section className="block" aria-labelledby="charts-title">
      <div className="block-head">
        <h2 id="charts-title">Charts</h2>
        <Segmented label="Candle interval" size="sm" options={INTERVALS} value={interval} onChange={setCandleInterval} />
      </div>
      <div className="grid-2">
        <figure className="card chart-card">
          <figcaption className="chart-card__cap">
            <span className="num">{market}</span> perp <span className="muted">· what the engine trades</span>
          </figcaption>
          <MarketChart symbol={market} interval={interval} />
        </figure>
        <figure className="card chart-card">
          <figcaption className="chart-card__cap">
            <span className="num">${symbol}</span> <span className="muted">· your token on Uniswap</span>
          </figcaption>
          <TokenChart address={address} symbol={symbol} interval={interval} />
        </figure>
      </div>
    </section>
  );
}
