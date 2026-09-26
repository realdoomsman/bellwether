export type LaunchpadId = 'pons' | 'launchhood';

export interface LaunchpadInfo {
  id: LaunchpadId;
  name: string;
  url: string;
  /** Name of the launchpad form field that must be set to the protocol wallet. */
  feeField: string;
  /** Where that field lives in the launchpad UI. */
  feeFieldLocation: string;
  launchFeeEth: number | null;
  /** Other launch-form settings the engine depends on; shown in the launch wizard and docs. */
  requirements: readonly string[];
  /** Honest caveats about how this launchpad pays or controls creator fees. */
  caveats: readonly string[];
}

export const LAUNCHPADS: Record<LaunchpadId, LaunchpadInfo> = {
  pons: {
    id: 'pons',
    name: 'Pons',
    url: 'https://www.ponsfamily.com/launchpad/create',
    feeField: 'Creator wallet',
    feeFieldLocation: 'Create → Advanced',
    launchFeeEth: 0.0005,
    requirements: ['Keep “Paired asset” set to ETH.', 'Leave “Holder fee sharing” off.'],
    caveats: [],
  },
  launchhood: {
    id: 'launchhood',
    name: 'LaunchHood',
    url: 'https://launchhood.com',
    feeField: 'Reward recipient',
    feeFieldLocation: 'Create coin → Advanced',
    launchFeeEth: null,
    requirements: [],
    caveats: [
      'LaunchHood pays the reward recipient 50% of LP fees; the rest stays with LaunchHood.',
      'LaunchHood’s admin can change a token’s reward recipient.',
    ],
  },
};

export const LAUNCHPAD_IDS = Object.keys(LAUNCHPADS) as LaunchpadId[];

export function isLaunchpadId(v: unknown): v is LaunchpadId {
  return typeof v === 'string' && Object.hasOwn(LAUNCHPADS, v);
}
