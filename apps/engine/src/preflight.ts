/**
 * Live-mode startup preflight: RPC and Hyperliquid reachability, protocol wallet gas, and the Hyperliquid account.
 * Only definite misconfiguration is fatal (an RPC serving the wrong chain, a key that is not a Hyperliquid user, a
 * missing HIP-3 dex); anything that may be transient (timeouts, errors, low balances) is a warning, because the
 * workers retry and page on repeated failures anyway.
 */
import type { Address } from '@bellwether/shared';
import { shortError } from './integrations/errors.ts';
import type { LiveProbes } from './ports.ts';

export const PREFLIGHT_TIMEOUT_MS = 15_000;

export interface PreflightExpect {
  rhcChainId: number;
  arbitrumChainId: number;
  rhcGasReserveEth: number;
  hyperliquidDex: string;
  protocolAddress: Address;
}

export interface PreflightReport {
  /** Refuse to start. */
  fatal: string[];
  warnings: string[];
}

export async function livePreflight(probes: LiveProbes, expect: PreflightExpect, timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<PreflightReport> {
  // Executor form: the tsconfig lib predates Promise.withResolvers.
  const bounded = <T>(label: string, run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: no answer within ${timeoutMs / 1000}s`)), timeoutMs);
      run().then(resolve, reject).finally(() => clearTimeout(timer));
    });
  const [rhcChain, arbChain, rhcEth, arbEth, role, dexListed] = await Promise.allSettled([
    bounded('Robinhood Chain RPC', probes.rhcChainId),
    bounded('Arbitrum RPC', probes.arbitrumChainId),
    bounded('Robinhood Chain RPC', probes.rhcBalanceEth),
    bounded('Arbitrum RPC', probes.arbitrumBalanceEth),
    bounded('Hyperliquid info', probes.hyperliquidRole),
    bounded('Hyperliquid info', probes.hyperliquidDexListed),
  ]);
  const report: PreflightReport = { fatal: [], warnings: [] };
  const failed = (r: PromiseRejectedResult, what: string) => report.warnings.push(`${what} unreachable (${shortError(r.reason)})`);

  for (const [r, env, want, name] of [
    [rhcChain, 'ROBINHOOD_RPC_URL', expect.rhcChainId, 'Robinhood Chain RPC'],
    [arbChain, 'ARBITRUM_RPC_URL', expect.arbitrumChainId, 'Arbitrum RPC'],
  ] as const) {
    if (r.status === 'rejected') report.warnings.push(`${name} unreachable (${shortError(r.reason)}); its workers fail and retry until it answers`);
    else if (r.value !== want) report.fatal.push(`${env} serves chain ${r.value}, expected ${want}`);
  }

  if (rhcEth.status === 'rejected') failed(rhcEth, 'Robinhood Chain wallet balance');
  else if (rhcEth.value < expect.rhcGasReserveEth) {
    report.warnings.push(
      `protocol wallet holds ${rhcEth.value} ETH on Robinhood Chain, below RHC_GAS_RESERVE_ETH ${expect.rhcGasReserveEth}: buybacks and bridging are refused and claims may not afford gas`,
    );
  }
  if (arbEth.status === 'rejected') failed(arbEth, 'Arbitrum wallet balance');
  else if (!(arbEth.value > 0)) report.warnings.push('protocol wallet holds no ETH on Arbitrum: margin top-ups (USDC deposits to Hyperliquid) cannot pay gas');

  if (role.status === 'rejected') failed(role, 'Hyperliquid account lookup');
  else if (role.value === 'missing') {
    report.warnings.push(`Hyperliquid has no account for ${expect.protocolAddress} yet; the first margin top-up (a USDC deposit) creates it`);
  } else if (role.value === 'agent' || role.value === 'vault') {
    report.fatal.push(`${expect.protocolAddress} is a Hyperliquid ${role.value}, not a user account: the engine trades and reads positions as that address itself`);
  } else if (role.value !== 'user' && role.value !== 'subAccount') {
    report.warnings.push(`Hyperliquid reports an unexpected role "${role.value}" for ${expect.protocolAddress}`);
  }

  if (dexListed.status === 'rejected') failed(dexListed, 'Hyperliquid perp dex list');
  else if (!dexListed.value) report.fatal.push(`Hyperliquid perp dex "${expect.hyperliquidDex}" (HYPERLIQUID_DEX) is not listed in perpDexs`);
  return report;
}
