import type { ActivityEvent, Candle, CandleInterval, TradeView } from '@bellwether/shared';
import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { ChartMarker } from '../../components/CandleChart';
import { ErrorNotice } from '../../components/DataState';
import { Segmented } from '../../components/Segmented';
import { Change } from '../../components/Stat';
import { pct, price } from '../../lib/format';
import { useMarketCandles, useMarkets, useTokenCandles } from '../../lib/queries';

// lightweight-charts loads only when a chart is about to scroll into view.
const CandleChart = lazy(() => import('../../components/CandleChart').then((m) => ({ default: m.CandleChart })));

const INTERVALS = [
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '1d', label: '1d' },
] as const satisfies readonly { value: CandleInterval; label: string }[];

const INTERVAL_MS: Record<CandleInterval, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 };
const INTERVAL_WORDS: Record<CandleInterval, string> = { '5m': '5-minute', '15m': '15-minute', '1h': 'hourly', '1d': 'daily' };

type Tab = 'token' | 'market';

/** Markers snap to the candle they fall in; anything outside the loaded range is dropped. */
function inRange(markers: ChartMarker[], candles: Candle[], interval: CandleInterval): ChartMarker[] {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) return [];
  const ms = INTERVAL_MS[interval];
  return markers.filter((m) => m.time >= first.t && m.time < last.t + ms).map((m) => ({ ...m, time: Math.floor(m.time / ms) * ms }));
}

/** The visible text version of a chart: range, move, extremes and what's marked. */
function summary(candles: Candle[], what: string, marked: ChartMarker[]): string {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) return '';
  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const move = first.o > 0 ? (last.c - first.o) / first.o : 0;
  const burns = marked.filter((m) => m.kind === 'burn').length;
  const trades = marked.length - burns;
  const marks = [burns > 0 && `${burns} ${burns === 1 ? 'burn' : 'burns'}`, trades > 0 && `${trades} ${trades === 1 ? 'trade' : 'trades'}`].filter(Boolean).join(' and ');
  return `${what}: ${pct(move, { signed: true })} over ${candles.length} candles, last ${price(last.c)}, high ${price(high)}, low ${price(low)}.${marks ? ` ${marks} marked.` : ''}`;
}

/** Mount children only once the box is within 200 px of the viewport. */
function useNear<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/**
 * Two charts behind tabs: the token's DEX price and the perp the engine trades for it. Burns are
 * brass marks on the token chart, trades ▲▼ on the perp. A token still on its bonding curve says
 * so in the chart area instead of drawing an empty box. Opens on the tab that has data.
 */
export function Charts({
  address,
  symbol,
  market,
  side,
  priceUsd,
  change24hPct,
  activity,
  trades,
  titleId,
}: {
  address: string;
  symbol: string;
  market: string;
  side: 'long' | 'short';
  priceUsd: number | null;
  change24hPct: number | null;
  activity: ActivityEvent[];
  /** Null for a burn-only token: it never trades, so there is no perp chart. */
  trades: TradeView[] | null;
  titleId: string;
}) {
  const [interval, setCandleInterval] = useState<CandleInterval>('15m');
  const [picked, setPicked] = useState<Tab | null>(null);
  const tokenQ = useTokenCandles(address, interval);
  const marketQ = useMarketCandles(market, interval);
  const perp = useMarkets().data?.markets.find((m) => m.symbol === market);
  const [box, near] = useNear<HTMLDivElement>();
  const ids = useId();
  const tokenEmpty = tokenQ.data !== undefined && tokenQ.data.candles.length === 0;
  const tab: Tab = trades === null ? 'token' : (picked ?? (tokenEmpty ? 'market' : 'token'));
  const q = tab === 'token' ? tokenQ : marketQ;
  const candles = q.data?.candles ?? [];
  const height = typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches ? 360 : 260;

  const markers: ChartMarker[] =
    tab === 'token'
      ? activity.filter((e) => e.kind === 'buyback').map((e) => ({ time: e.at, kind: 'burn' }))
      : (trades ?? []).map((tr) => ({ time: tr.at, kind: (tr.action === 'open') === (side === 'long') ? 'buy' : 'sell' }));
  const marked = inRange(markers, candles, interval);
  const what = tab === 'token' ? `$${symbol} on its DEX, ${INTERVAL_WORDS[interval]} candles` : `${market} perp, ${INTERVAL_WORDS[interval]} candles`;
  const quote = tab === 'token' ? { px: priceUsd, change: change24hPct, source: 'DEX price' } : { px: perp?.price ?? null, change: perp?.change24hPct ?? null, source: 'Hyperliquid mark' };

  const tabs: { id: Tab; label: string }[] = [{ id: 'token', label: `$${symbol} price` }, ...(trades === null ? [] : [{ id: 'market' as const, label: `${market} perp` }])];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || tabs.length < 2) return;
    e.preventDefault();
    const next: Tab = tab === 'token' ? 'market' : 'token';
    setPicked(next);
    requestAnimationFrame(() => document.getElementById(`${ids}-tab-${next}`)?.focus());
  };

  let area;
  if (!q.data) {
    area = q.error ? (
      <div className="chart-area__msg">
        <ErrorNotice error={q.error} onRetry={q.refresh} what={tab === 'token' ? `$${symbol} chart` : `${market} chart`} compact />
      </div>
    ) : (
      <p className="chart-area__msg" role="status">
        Loading {INTERVAL_WORDS[interval]} candles…
      </p>
    );
  } else if (candles.length === 0) {
    area = (
      <p className="chart-area__msg">
        {tab === 'token'
          ? `No DEX price yet. $${symbol} is still on the launchpad’s bonding curve; its chart starts when it graduates to a Uniswap pool.`
          : `The venue returned no ${market} candles at ${interval}. Try another interval.`}
      </p>
    );
  } else {
    area = near ? (
      <Suspense fallback={<p className="chart-area__msg">Drawing the chart…</p>}>
        <CandleChart candles={candles} label={what} height={height} markers={marked} />
      </Suspense>
    ) : null;
  }

  return (
    <>
      <div className="panel-head">
        <h2 id={titleId} className="panel-head__title">
          Charts
        </h2>
        <Segmented label="Candle interval" size="sm" options={INTERVALS} value={interval} onChange={setCandleInterval} />
      </div>
      <div className="chart-bar">
        <div className="chart-tabs" role="tablist" aria-label="Chart" onKeyDown={onKey}>
          {tabs.map((x) => (
            <button
              key={x.id}
              id={`${ids}-tab-${x.id}`}
              type="button"
              role="tab"
              className="chart-tabs__tab"
              aria-selected={tab === x.id}
              aria-controls={`${ids}-panel`}
              tabIndex={tab === x.id ? 0 : -1}
              onClick={() => setPicked(x.id)}
            >
              {x.label}
              {x.id === 'token' && tokenEmpty && <span className="chart-tabs__hint">no DEX data</span>}
            </button>
          ))}
        </div>
        <p className="chart-quote">
          <span className="chart-quote__px num">{price(quote.px)}</span>
          {quote.change !== null && <Change frac={quote.change} />}
          <span className="muted">{quote.change !== null ? '24h · ' : ''}{quote.source}</span>
        </p>
      </div>
      <div ref={box} id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`} className="chart-area" style={{ minHeight: height }}>
        {area}
      </div>
      {candles.length > 0 && (
        <div className="chart-foot">
          <p className="chart-foot__sum">{summary(candles, what, marked)}</p>
          <p className="chart-foot__key" aria-hidden="true">
            {tab === 'token' ? (
              <>
                <span className="chart-key chart-key--burn" /> burn
              </>
            ) : (
              <>
                <span className="up">▲</span> entry <span className="down">▼</span> exit
              </>
            )}
          </p>
        </div>
      )}
    </>
  );
}
