import type { Candle } from '@floor/shared';
import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { pct, price } from '../lib/format';

const COLORS = { up: '#2BD67B', down: '#FF5A5F', text: '#9A9284', grid: 'rgba(244,241,234,0.05)', line: '#3B3732' };

/** Text alternative for a candle series: range, move and extremes. */
export function describeCandles(candles: Candle[], what: string): string {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) return `${what}: no data`;
  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const move = first.o > 0 ? (last.c - first.o) / first.o : 0;
  return `${what}: ${candles.length} candles, last ${price(last.c)}, ${pct(move, { signed: true })} over the period, high ${price(high)}, low ${price(low)}.`;
}

export function CandleChart({ candles, label, height = 320 }: { candles: Candle[]; label: string; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: COLORS.text,
        fontFamily: "'Geist Mono', ui-monospace, monospace",
        fontSize: 12,
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.line },
      timeScale: { borderColor: COLORS.line, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: COLORS.line }, horzLine: { color: COLORS.line } },
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderUpColor: COLORS.up,
      borderDownColor: COLORS.down,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    // The chart requires strictly ascending, unique times (seconds).
    const byTime = new Map<number, Candle>();
    for (const c of candles) byTime.set(Math.floor(c.t / 1000), c);
    const data = [...byTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, c]) => ({ time: t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c }));
    series.current.setData(data);
    chart.current.timeScale().fitContent();
  }, [candles]);

  return <div ref={host} className="chart" style={{ height }} role="img" aria-label={describeCandles(candles, label)} />;
}
