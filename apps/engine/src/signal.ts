/**
 * Entry signal scoring, ported from the reference engine's multi-indicator model and
 * rescaled from 1m to 5m candles (the finest interval our price feed guarantees).
 * Pure functions: candles in, score out.
 */
import type { Candle, MarketSession } from '@bellwether/shared';

export type Bias = 'long' | 'short' | 'wait';

export interface Signal {
  /** -100..100; positive favors longs. */
  score: number;
  bias: Bias;
  /** Leverage the signal's conviction supports before any strategy/venue caps. */
  suggestedLeverage: number;
  components: Record<string, number>;
}

export interface SignalInput {
  /** 5m candles, oldest first; needs >= 50 for a score. */
  fast: readonly Candle[];
  /** 15m candles; needs >= 10. */
  mid: readonly Candle[];
  /** 1h candles; optional trend filter. */
  slow: readonly Candle[];
  session: MarketSession;
}

/** Score magnitude at which the bias leaves `wait`. */
export const BIAS_THRESHOLD = 25;
/** An open position is exited early when the score moves this far against it and it is losing. */
export const FLIP_THRESHOLD = 30;

const NEUTRAL: Signal = { score: 0, bias: 'wait', suggestedLeverage: 0, components: {} };

export function sma(values: readonly number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return values[values.length - 1]!;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i]!;
  return s / period;
}

export function ema(values: readonly number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

/** Wilder RSI; 50 when there is not enough data, 100 when there were no losses. */
export function rsi(closes: readonly number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Average true range over the last `period` bars (simple mean of true ranges). */
export function atr(candles: readonly Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prevClose = candles[i - 1]!.c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose)));
  }
  return sma(trs, Math.min(period, trs.length));
}

export function macd(closes: readonly number[]): number {
  return ema(closes, 12) - ema(closes, 26);
}

/** High volume confirms the direction of the recent candles. */
export function volumeScore(candles: readonly Candle[]): number {
  if (candles.length < 30) return 0;
  const volumes = candles.map((c) => c.v);
  const avg = sma(volumes, 20);
  const recent = sma(volumes.slice(-5), 5);
  const ratio = avg > 0 ? recent / avg : 1;
  const last5 = candles.slice(-5);
  const bullish = last5.filter((c) => c.c > c.o).reduce((s, c) => s + c.v, 0);
  const bearish = last5.filter((c) => c.c <= c.o).reduce((s, c) => s + c.v, 0);
  const dir = bullish > bearish ? 1 : -1;
  if (ratio > 2) return 15 * dir;
  if (ratio > 1.5) return 10 * dir;
  if (ratio > 1) return 5 * dir;
  return 0;
}

/** Price discovery happens in regular hours; overnight/weekend flow is thin. */
export const SESSION_SCORE: Record<MarketSession, number> = {
  regular: 15,
  pre: 5,
  post: 5,
  overnight: 0,
  weekend: -10,
};

export function leverageForConfidence(confidence: number): number {
  if (confidence >= 80) return 20;
  if (confidence >= 60) return 15;
  if (confidence >= 40) return 10;
  return 5;
}

export function computeSignal(input: SignalInput): Signal {
  const { fast, mid, slow } = input;
  if (fast.length < 50 || mid.length < 10) return NEUTRAL;
  const closes = fast.map((c) => c.c);
  const midCloses = mid.map((c) => c.c);
  const slowCloses = slow.map((c) => c.c);
  const price = closes[closes.length - 1]!;
  if (!(price > 0)) return NEUTRAL;

  // 1. Momentum: EMA stack on the fast timeframe.
  const ema5 = ema(closes, 5);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const momentum = (ema5 > ema20 ? 15 : -15) + (ema20 > ema50 ? 10 : -10) + (price > ema20 ? 5 : -5);

  // 2. RSI, overbought only counts against a long when the higher-timeframe trend is weak.
  const r = rsi(closes, 14);
  const htfBullish = slowCloses.length >= 50 && ema(slowCloses, 10) > ema(slowCloses, 50);
  let rsiScore = 0;
  if (r < 30) rsiScore = 20;
  else if (r < 40) rsiScore = 10;
  else if (r > 70) rsiScore = htfBullish ? 5 : -20;
  else if (r > 60) rsiScore = -5;

  // 3. MACD sign.
  const macdScore = macd(closes) > 0 ? 10 : -10;

  // 4. Higher-timeframe trend: 15m EMA cross, then 1h EMA200 (or EMA50 with shorter history).
  let htf = 0;
  if (midCloses.length >= 20) htf += ema(midCloses, 10) > ema(midCloses, 20) ? 10 : -10;
  if (slowCloses.length >= 200) htf += price > ema(slowCloses, 200) ? 10 : -10;
  else if (slowCloses.length >= 50) htf += price > ema(slowCloses, 50) ? 5 : -5;

  // 5. Volatility band: 5m ATR between ~0.045% and ~0.34% of price is tradable (1m band 0.02–0.15% scaled by √5).
  const atrPct = (atr(fast, 14) / price) * 100;
  let volatility = -10;
  if (atrPct > 0.045 && atrPct < 0.34) volatility = 10;
  else if (atrPct >= 0.34) volatility = -5;

  // 6. Session, 7. volume confirmation.
  const session = SESSION_SCORE[input.session];
  const volume = volumeScore(fast);

  // 8. Recent move over the last 5 bars (thresholds scaled by √5 from the 1m model).
  const last5 = closes.slice(-5);
  const recentMove = ((last5[last5.length - 1]! - last5[0]!) / last5[0]!) * 100;
  let recent = 0;
  if (recentMove > 0.11) recent = 10;
  else if (recentMove > 0.045) recent = 5;
  else if (recentMove < -0.11) recent = -10;
  else if (recentMove < -0.045) recent = -5;

  const components = { momentum, rsi: rsiScore, macd: macdScore, htf, volatility, session, volume, recent };
  const raw = Object.values(components).reduce((s, v) => s + v, 0);
  const score = Math.max(-100, Math.min(100, raw));
  const bias: Bias = score >= BIAS_THRESHOLD ? 'long' : score <= -BIAS_THRESHOLD ? 'short' : 'wait';
  return { score, bias, suggestedLeverage: leverageForConfidence(Math.abs(score)), components };
}
