import type { LaunchpadId } from '@bellwether/shared';

/**
 * What each launchpad's create form looks like, for the illustrated plate in step 3. Transcribed from
 * the live forms (ponsfamily.com/launchpad/create and launchhood.com/create, September 2026): field
 * order, the fee field's placeholder and helper text, and the settings our engine depends on.
 * The fee field's label itself always comes from LAUNCHPADS[id].feeField.
 */
export interface FormSpec {
  /** Where the form lives, as shown in the address bar. */
  page: string;
  /** The form's own heading. */
  title: string;
  /** Plain fields above the advanced section, as rows of one or two. */
  rows: readonly (readonly string[])[];
  /** A setting the engine depends on, shown with the value it must keep. */
  keep: { label: string; value: string; note: string } | null;
  /** Settings inside the advanced section that sit above the fee field. */
  advanced: readonly { label: string; value: string; note: string | null }[];
  /** The fee field's own placeholder and helper text on the launchpad. */
  placeholder: string;
  hint: string;
  /** Whether the launchpad marks the fee field optional in its label. */
  optional: boolean;
  submit: string;
}

export const FORM_SPEC: Record<LaunchpadId, FormSpec> = {
  pons: {
    page: 'ponsfamily.com/launchpad/create',
    title: 'Launch token',
    rows: [['Name', 'Ticker'], ['Description'], ['Token image']],
    keep: { label: 'Paired asset', value: 'ETH', note: 'Keep ETH' },
    advanced: [{ label: 'Holder fee sharing', value: 'Off', note: 'Leave off' }],
    placeholder: 'Connected wallet',
    hint: 'Receives creator fees and the creator tax. Leave blank to use your connected wallet.',
    optional: false,
    submit: 'Launch token',
  },
  launchhood: {
    page: 'launchhood.com/create',
    title: 'Create coin',
    rows: [['Image'], ['Name', 'Ticker'], ['Description'], ['Initial buy (ETH, optional)']],
    keep: null,
    advanced: [],
    placeholder: '0x… (defaults to your wallet)',
    hint: 'Address that earns the creator share of the locked-LP trading fees. Leave empty to earn them yourself.',
    optional: true,
    submit: 'Launch coin',
  },
};
