import { STRATEGIES, type StrategyId } from './strategies.ts';

export interface FeeSplit {
  /** Funds the token's share of the stock-perp book. */
  trading: number;
  /** Buys back and burns the token that generated the fee. */
  tokenBuyback: number;
  /** Buys back and burns the protocol token (BRAND.ticker). */
  protocolBuyback: number;
}

/**
 * Every claimed creator fee is split immediately. Unlike a profits-only model, a quarter of
 * every fee hits the token's own chart right away, so the floor rises even if trading loses.
 */
export const FEE_SPLIT_TRADING: FeeSplit = { trading: 0.6, tokenBuyback: 0.25, protocolBuyback: 0.15 };
export const FEE_SPLIT_BURN_ONLY: FeeSplit = { trading: 0, tokenBuyback: 0.85, protocolBuyback: 0.15 };

/** Realized trading profit (not returned collateral) is split this way. */
export const PROFIT_SPLIT = { tokenBuyback: 0.8, protocolBuyback: 0.2 } as const;

export function feeSplitFor(strategy: StrategyId): FeeSplit {
  return STRATEGIES[strategy].trades ? FEE_SPLIT_TRADING : FEE_SPLIT_BURN_ONLY;
}

/**
 * Split an integer amount (wei) exactly: parts sum to `amount`, rounding dust goes to tokenBuyback.
 */
export function splitWei(amount: bigint, split: FeeSplit): { trading: bigint; tokenBuyback: bigint; protocolBuyback: bigint } {
  // Basis-point integer math keeps the split exact in wei.
  const trading = (amount * BigInt(Math.round(split.trading * 10_000))) / 10_000n;
  const protocolBuyback = (amount * BigInt(Math.round(split.protocolBuyback * 10_000))) / 10_000n;
  return { trading, protocolBuyback, tokenBuyback: amount - trading - protocolBuyback };
}
