import type { MarketSession } from './session.ts';

export type StrategyId = 'steady' | 'balanced' | 'degen' | 'burn';

export interface ExitLadder {
  /** Favorable underlying move (fraction, e.g. 0.005 = 0.5%) that arms the breakeven stop. */
  breakevenArmMove: number;
  /** First take-profit: underlying move and fraction of the position to close. */
  tp1Move: number;
  tp1Fraction: number;
  /** Second take-profit: underlying move and fraction of the *remaining* position to close. */
  tp2Move: number;
  tp2Fraction: number;
  /** After TP2, close the remainder when price pulls back this far from the best price seen. */
  trailPullback: number;
}

export interface Strategy {
  id: StrategyId;
  label: string;
  tagline: string;
  description: string;
  /** False = never opens positions; the trading share of fees goes to buyback instead. */
  trades: boolean;
  minLeverage: number;
  maxLeverage: number;
  /** Hard stop as a fraction of collateral (negative). -0.3 = close at -30% of collateral. */
  stopLoss: number;
  /** Added to the base signal threshold. Higher = pickier entries. */
  entryThresholdBonus: number;
  /** US equity sessions in which new entries are allowed. Exits run in every session. */
  sessions: readonly MarketSession[];
  /** Realized loss per UTC day (fraction of the token's trading budget) that halts new entries. */
  dailyLossLimit: number;
  exits: ExitLadder;
}

const LADDER: ExitLadder = {
  breakevenArmMove: 0.005,
  tp1Move: 0.005,
  tp1Fraction: 0.25,
  tp2Move: 0.01,
  tp2Fraction: 0.33,
  trailPullback: 0.005,
};

export const STRATEGIES: Record<StrategyId, Strategy> = {
  steady: {
    id: 'steady',
    label: 'Steady',
    tagline: 'Low leverage, market hours only',
    description:
      'Trades 2-5x during regular NYSE hours only. Tight stop at -20% of collateral. Picky entries.',
    trades: true,
    minLeverage: 2,
    maxLeverage: 5,
    stopLoss: -0.2,
    entryThresholdBonus: 15,
    sessions: ['regular'],
    dailyLossLimit: 0.1,
    exits: LADDER,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    tagline: 'Moderate leverage, extended hours',
    description:
      'Trades 3-10x during regular and extended hours. Stop at -30% of collateral. The default.',
    trades: true,
    minLeverage: 3,
    maxLeverage: 10,
    stopLoss: -0.3,
    entryThresholdBonus: 5,
    sessions: ['pre', 'regular', 'post'],
    dailyLossLimit: 0.2,
    exits: LADDER,
  },
  degen: {
    id: 'degen',
    label: 'Degen',
    tagline: 'High leverage, around the clock',
    description:
      'Trades 5-20x in every session the venue offers. Stop at -40% of collateral. Liquidation is a real outcome.',
    trades: true,
    minLeverage: 5,
    maxLeverage: 20,
    stopLoss: -0.4,
    entryThresholdBonus: 0,
    sessions: ['pre', 'regular', 'post', 'overnight', 'weekend'],
    dailyLossLimit: 0.35,
    exits: LADDER,
  },
  burn: {
    id: 'burn',
    label: 'Burn only',
    tagline: 'No trading, pure buyback',
    description:
      'Never trades. The trading share of fees buys back and burns your token instead.',
    trades: false,
    minLeverage: 0,
    maxLeverage: 0,
    stopLoss: 0,
    entryThresholdBonus: 0,
    sessions: [],
    dailyLossLimit: 0,
    exits: LADDER,
  },
};

export const STRATEGY_IDS = Object.keys(STRATEGIES) as StrategyId[];
export const DEFAULT_STRATEGY: StrategyId = 'balanced';

export function isStrategyId(v: unknown): v is StrategyId {
  return typeof v === 'string' && Object.hasOwn(STRATEGIES, v);
}

/** Leverage a token can actually receive: the strictest of the token cap, strategy cap and venue cap. */
export function effectiveLeverageCap(strategy: StrategyId, tokenCap: number, venueCap: number): number {
  const s = STRATEGIES[strategy];
  if (!s.trades) return 0;
  return Math.max(0, Math.min(s.maxLeverage, tokenCap, venueCap));
}

export interface LeverageBounds {
  min: number;
  max: number;
}

/**
 * Leverage a creator may request for a trading `strategy` on a market whose venue cap is `venueCap`,
 * or 'unavailable' when the venue caps the market below the strategy's minimum (the strategy can't run there).
 * Burn-only strategies have the fixed range 0..0.
 */
export function leverageBounds(strategy: StrategyId, venueCap: number): LeverageBounds | 'unavailable' {
  const s = STRATEGIES[strategy];
  if (!s.trades) return { min: 0, max: 0 };
  const max = effectiveLeverageCap(strategy, s.maxLeverage, venueCap);
  return max < s.minLeverage ? 'unavailable' : { min: s.minLeverage, max };
}
