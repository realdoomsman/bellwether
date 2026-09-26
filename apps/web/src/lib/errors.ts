import { BRAND } from '@stepup/shared';
import { ApiRequestError } from './api';

/** Human copy for every ApiError code the engine documents. Falls back to the server message. */
const MESSAGES: Record<string, string> = {
  engine_offline: `The ${BRAND.name} engine is unreachable. Nothing was sent; try again in a moment.`,
  client_error: 'Something went wrong in the browser. Reload the page and try again.',
  internal: 'The engine hit an internal error. Nothing was changed; try again shortly.',
  rate_limited: 'Too many requests. Wait a few seconds and try again.',
  payload_too_large: 'The request was too large. Reload the page and try again.',
  invalid_body: 'The request was malformed. Reload the page and try again.',
  invalid_query: 'That query is not valid.',
  invalid_address: 'That is not a valid token address. It should be 0x followed by 40 hex characters.',
  invalid_interval: 'That chart interval is not supported.',
  not_found: `This token is not registered with ${BRAND.name}.`,
  unknown_market: `That market is not one ${BRAND.name} trades.`,
  unsupported_launchpad: `${BRAND.name} supports Pons and LaunchHood only.`,
  unsupported_market: 'That market is not available on the active venue right now. Pick another stock.',
  invalid_strategy: 'Unknown strategy. Pick Steady, Balanced, Degen or Burn only.',
  short_unavailable: `Shorts are not available yet. ${BRAND.name} currently trades long only.`,
  invalid_leverage: 'That leverage is outside what the strategy and venue allow.',
  leverage_unavailable: 'This market’s leverage cap is below the strategy’s minimum, so that strategy can’t trade it. Pick another strategy or market.',
  no_contract: 'No contract exists at that address on Robinhood Chain. Double-check you copied the token address, not your wallet.',
  wrong_launchpad: 'This token was not created by the launchpad you selected. Go back and pick the launchpad you used.',
  not_protocol_creator: `The fee recipient on this token is not the ${BRAND.name} wallet, so ${BRAND.name} would never receive its fees. Launch a new token with the ${BRAND.name} wallet in the fee field.`,
  impersonation: `This token looks like it impersonates $${BRAND.ticker} and cannot be registered.`,
  already_registered: `This token is already registered with ${BRAND.name}.`,
  rpc_error: 'Robinhood Chain or the trading venue did not answer the lookup. Try again in a moment.',
  no_deployer: `${BRAND.name} could not determine who deployed this token, so creator settings are unavailable.`,
  invalid_nonce: 'That signature request is no longer valid: it was already used or replaced by a newer one. Start again to get a fresh one.',
  nonce_expired: 'The signature request expired. Start again to get a fresh one.',
  bad_signature: 'The signature did not come from the token deployer.',
  unauthorized: 'Not authorized.',
  admin_disabled: 'Admin actions are disabled on this engine.',
  wallet_not_configured: `${BRAND.name}’s protocol wallet isn’t live yet, so tokens can’t be verified or registered. Don’t launch with a fee recipient until it is.`,
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if ((err.code === 'invalid_leverage' || err.code === 'leverage_unavailable') && err.details) {
      const { min, max } = err.details as { min?: number; max?: number };
      if (typeof min === 'number' && typeof max === 'number') {
        return err.code === 'invalid_leverage'
          ? `Leverage must be between ${min}× and ${max}× for this strategy and venue.`
          : `This market allows at most ${max}×, below the strategy’s ${min}× minimum. Pick another strategy or market.`;
      }
    }
    if (err.code === 'already_registered' && typeof err.details?.status === 'string') {
      return `This token is already registered with ${BRAND.name} (status: ${err.details.status}).`;
    }
    return MESSAGES[err.code] ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
