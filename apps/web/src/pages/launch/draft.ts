import { DEFAULT_STRATEGY, isLaunchpadId, isStockSymbol, isStrategyId, type LaunchpadId, type StrategyId } from '@stepup/shared';

/** Wizard state, persisted to localStorage so a creator can leave for the launchpad and come back. */
export interface Draft {
  launchpad: LaunchpadId | null;
  market: string | null;
  strategy: StrategyId;
  /** Chosen leverage cap; ignored for strategies that never trade. */
  maxLeverage: number | null;
  walletConfirmed: boolean;
  address: string;
  registered: { address: string; activated: boolean } | null;
}

export const EMPTY_DRAFT: Draft = {
  launchpad: null,
  market: null,
  strategy: DEFAULT_STRATEGY,
  maxLeverage: null,
  walletConfirmed: false,
  address: '',
  registered: null,
};

export const DRAFT_KEY = 'stepup.launch.v1';

export function parseDraft(raw: unknown): Draft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const registered = r.registered as Draft['registered'] | undefined;
  return {
    launchpad: isLaunchpadId(r.launchpad) ? r.launchpad : null,
    market: isStockSymbol(r.market) ? r.market.toUpperCase() : null,
    strategy: isStrategyId(r.strategy) ? r.strategy : DEFAULT_STRATEGY,
    maxLeverage: typeof r.maxLeverage === 'number' && Number.isFinite(r.maxLeverage) ? r.maxLeverage : null,
    walletConfirmed: r.walletConfirmed === true,
    address: typeof r.address === 'string' ? r.address : '',
    registered:
      registered && typeof registered.address === 'string' && typeof registered.activated === 'boolean'
        ? { address: registered.address, activated: registered.activated }
        : null,
  };
}

export const STEPS = [
  { n: 1, label: 'Launchpad' },
  { n: 2, label: 'Configure' },
  { n: 3, label: 'Launch' },
  { n: 4, label: 'Verify & register' },
] as const;

/** Highest step the draft may open: every earlier step must be complete. */
export function maxStep(d: Draft): number {
  if (!d.launchpad) return 1;
  if (!d.market || (d.strategy !== 'burn' && d.maxLeverage === null)) return 2;
  if (!d.walletConfirmed) return 3;
  return 4;
}
