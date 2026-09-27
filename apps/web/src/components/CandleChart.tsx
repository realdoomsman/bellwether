import type { Candle } from '@bellwether/shared';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { pct, price } from '../lib/format';
import { useTheme } from '../lib/prefs';

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

/** Chart events: brass for burns, up/down arrows for trades. `time` is epoch ms. */
export interface ChartMarker {
  time: number;
  kind: 'burn' | 'buy' | 'sell';
  text?: string;
}

const NO_MARKERS: ChartMarker[] = [];

/** Palette read from the live CSS tokens, so the canvas follows the theme like the rest of the page. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { up: v('--up'), down: v('--down'), text: v('--ink-3'), grid: v('--rule'), line: v('--rule-strong'), brass: v('--brass'), ink: v('--ink') };
}

export function CandleChart({ candles, label, height = 320, markers = NO_MARKERS }: { candles: Candle[]; label: string; height?: number; markers?: ChartMarker[] }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markerApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const theme = useTheme();

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontFamily: "'Geist Mono Variable', ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.08 } },
    });
    series.current = c.addSeries(CandlestickSeries, { priceLineVisible: false });
    markerApi.current = createSeriesMarkers(series.current, []);
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      markerApi.current = null;
    };
  }, []);

  useEffect(() => {
    const p = palette();
    chart.current?.applyOptions({
      layout: { textColor: p.text },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.line },
      timeScale: { borderColor: p.line },
      crosshair: { vertLine: { color: p.line, labelBackgroundColor: p.ink }, horzLine: { color: p.line, labelBackgroundColor: p.ink } },
    });
    series.current?.applyOptions({ upColor: p.up, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down });
  }, [theme]);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    // The chart requires strictly ascending, unique times (seconds).
    const byTime = new Map<number, Candle>();
    for (const c of candles) byTime.set(Math.floor(c.t / 1000), c);
    const data = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => ({ time: t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c }));
    series.current.setData(data);
    chart.current.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    const p = palette();
    const list: SeriesMarker<Time>[] = [...markers]
      .sort((a, b) => a.time - b.time)
      .map((m) => ({
        time: Math.floor(m.time / 1000) as UTCTimestamp,
        position: m.kind === 'sell' ? 'aboveBar' : 'belowBar',
        shape: m.kind === 'burn' ? 'circle' : m.kind === 'buy' ? 'arrowUp' : 'arrowDown',
        color: m.kind === 'burn' ? p.brass : m.kind === 'buy' ? p.up : p.down,
        text: m.text,
      }));
    markerApi.current?.setMarkers(list);
  }, [markers, theme]);

  return <div ref={host} className="chart" style={{ height }} role="img" aria-label={describeCandles(candles, label)} />;
}
