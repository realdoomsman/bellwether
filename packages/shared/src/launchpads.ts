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
}

export const LAUNCHPADS: Record<LaunchpadId, LaunchpadInfo> = {
  pons: {
    id: 'pons',
    name: 'Pons',
    url: 'https://ponsfamily.com/launchpad',
    feeField: 'Creator wallet',
    feeFieldLocation: 'Create → Advanced',
    launchFeeEth: 0.0005,
  },
  launchhood: {
    id: 'launchhood',
    name: 'LaunchHood',
    url: 'https://launchhood.com',
    feeField: 'Reward recipient',
    feeFieldLocation: 'Create coin → Advanced',
    launchFeeEth: null,
  },
};

export const LAUNCHPAD_IDS = Object.keys(LAUNCHPADS) as LaunchpadId[];

export function isLaunchpadId(v: unknown): v is LaunchpadId {
  return typeof v === 'string' && Object.hasOwn(LAUNCHPADS, v);
}
