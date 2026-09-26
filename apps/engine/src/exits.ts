/**
 * Exit ladder for an open pooled position. Pure: position state + mark in, one action out.
 * Precedence: hard stop → liquidation buffer → signal flip → breakeven stop → TP1 → TP2 → trailing.
 */
import { STRATEGIES, type ExitLadder, type PositionView, type Side, type StrategyId, type TradeAction } from '@stepup/shared';
import { FLIP_THRESHOLD } from './signal.ts';

export type Stage = PositionView['stage'];

export interface ExitState {
  side: Side;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  collateralUsd: number;
  unrealizedPnlUsd: number;
  liquidationPrice: number | null;
  stage: Stage;
  bestPrice: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  liqReduced: boolean;
}

export interface ExitParams {
  /** Strictest participant stop, fraction of collateral (negative). */
  stopLoss: number;
  ladder: ExitLadder;
  liquidationBufferPct: number;
  /** Latest entry signal score for the market, if known. */
  signalScore: number | null;
}

export interface StatePatch {
  stage: Stage;
  bestPrice: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  liqReduced: boolean;
}

export type ExitDecision =
  | { kind: 'hold'; patch: StatePatch }
  | { kind: 'reduce'; fraction: number; action: TradeAction; reason: string; patch: StatePatch }
  | { kind: 'close'; action: TradeAction; reason: string };

/** Take-profits are skipped when the dollar gain would not cover noise and fees (capped at 1% of collateral for small pools). */
export const MIN_PROFIT_USD = 1;
/** Signal-flip exits only fire on positions already down at least this fraction of collateral. */
export const FLIP_MIN_LOSS = 0.1;
const PROTECTED: readonly Stage[] = ['breakeven', 'tp1', 'tp2', 'trailing'];

export function evaluateExit(s: ExitState, p: ExitParams): ExitDecision {
  const dir = s.side === 'long' ? 1 : -1;
  if (!(s.collateralUsd > 0) || !(s.entryPrice > 0) || !(s.markPrice > 0)) {
    return { kind: 'close', action: 'stop', reason: 'invalid position state' };
  }
  const pnlPct = s.unrealizedPnlUsd / s.collateralUsd;
  const move = (dir * (s.markPrice - s.entryPrice)) / s.entryPrice;
  const best = s.bestPrice > 0 ? (dir > 0 ? Math.max(s.bestPrice, s.markPrice) : Math.min(s.bestPrice, s.markPrice)) : s.markPrice;
  const patch: StatePatch = { stage: s.stage, bestPrice: best, tp1Hit: s.tp1Hit, tp2Hit: s.tp2Hit, liqReduced: s.liqReduced };

  if (pnlPct <= p.stopLoss) {
    return { kind: 'close', action: 'stop', reason: `stop ${(pnlPct * 100).toFixed(0)}%` };
  }

  if (s.liquidationPrice !== null && s.liquidationPrice > 0) {
    const span = Math.abs(s.entryPrice - s.liquidationPrice);
    const room = dir * (s.markPrice - s.liquidationPrice);
    if (span > 0 && room <= p.liquidationBufferPct * span) {
      if (!s.liqReduced) {
        return { kind: 'reduce', fraction: 0.5, action: 'reduce', reason: 'liquidation buffer', patch: { ...patch, liqReduced: true } };
      }
      if (room <= (p.liquidationBufferPct / 2) * span) {
        return { kind: 'close', action: 'stop', reason: 'liquidation buffer' };
      }
    }
  }

  if (p.signalScore !== null && dir * p.signalScore <= -FLIP_THRESHOLD && pnlPct < -FLIP_MIN_LOSS) {
    return { kind: 'close', action: 'close', reason: 'signal flip' };
  }

  if (PROTECTED.includes(s.stage) && move <= 0) {
    return { kind: 'close', action: 'close', reason: 'breakeven stop' };
  }

  const L = p.ladder;
  const minProfit = Math.min(MIN_PROFIT_USD, 0.01 * s.collateralUsd);
  if (s.stage === 'open' && move >= L.breakevenArmMove) patch.stage = 'breakeven';

  if (!s.tp1Hit && move >= L.tp1Move && s.unrealizedPnlUsd > minProfit) {
    return {
      kind: 'reduce',
      fraction: L.tp1Fraction,
      action: 'reduce',
      reason: 'take-profit 1',
      patch: { ...patch, stage: 'tp1', tp1Hit: true, bestPrice: s.markPrice },
    };
  }

  if (s.tp1Hit && !s.tp2Hit && move >= L.tp2Move && s.unrealizedPnlUsd > minProfit) {
    return {
      kind: 'reduce',
      fraction: L.tp2Fraction,
      action: 'reduce',
      reason: 'take-profit 2',
      patch: { ...patch, stage: 'trailing', tp2Hit: true, bestPrice: s.markPrice },
    };
  }

  if (s.stage === 'trailing') {
    const pullback = (dir * (best - s.markPrice)) / best;
    if (pullback >= L.trailPullback && s.unrealizedPnlUsd > 0) {
      return { kind: 'close', action: 'close', reason: 'trailing stop' };
    }
  }

  return { kind: 'hold', patch };
}

/** Price at which the current stage would exit on the downside, for display. */
export function stopPrice(s: Pick<ExitState, 'side' | 'entryPrice' | 'leverage' | 'stage' | 'bestPrice'>, stopLoss: number, ladder: ExitLadder): number | null {
  const dir = s.side === 'long' ? 1 : -1;
  if (!(s.entryPrice > 0)) return null;
  if (s.stage === 'open') return s.leverage > 0 ? s.entryPrice * (1 + (dir * stopLoss) / s.leverage) : null;
  if (s.stage === 'trailing' && s.bestPrice > 0) {
    const trail = s.bestPrice * (1 - dir * ladder.trailPullback);
    return dir > 0 ? Math.max(s.entryPrice, trail) : Math.min(s.entryPrice, trail);
  }
  return s.entryPrice;
}

/**
 * Exit rules for a pooled position: the strictest stop (closest to zero) among its trading
 * participants, with that strategy's ladder. Falls back to the stop recorded at open when no
 * participant trades anymore (e.g. all switched to burn-only while in the position).
 */
export function strictestRules(strategies: readonly StrategyId[], fallbackStop: number): { stopLoss: number; ladder: ExitLadder } {
  let best: { stopLoss: number; ladder: ExitLadder } | null = null;
  for (const id of strategies) {
    const s = STRATEGIES[id];
    if (!s.trades) continue;
    if (!best || s.stopLoss > best.stopLoss) best = { stopLoss: s.stopLoss, ladder: s.exits };
  }
  return best ?? { stopLoss: fallbackStop, ladder: STRATEGIES.balanced.exits };
}
