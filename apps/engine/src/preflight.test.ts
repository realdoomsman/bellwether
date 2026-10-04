import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveProbes } from './ports.ts';
import { livePreflight, type PreflightExpect } from './preflight.ts';

const expect: PreflightExpect = {
  rhcChainId: 4663,
  arbitrumChainId: 42161,
  rhcGasReserveEth: 0.01,
  hyperliquidDex: 'xyz',
  protocolAddress: '0x00000000000000000000000000000000000000a1',
};

function probes(over: Partial<LiveProbes> = {}): LiveProbes {
  return {
    rhcChainId: async () => 4663,
    arbitrumChainId: async () => 42161,
    rhcBalanceEth: async () => 0.5,
    arbitrumBalanceEth: async () => 0.01,
    hyperliquidRole: async () => 'user',
    hyperliquidDexListed: async () => true,
    ...over,
  };
}

test('a healthy live setup passes the preflight with nothing to report', async () => {
  assert.deepEqual(await livePreflight(probes(), expect), { fatal: [], warnings: [] });
});

test('network trouble and low balances only warn; the engine still starts', async () => {
  const down = async (): Promise<never> => {
    throw new Error('fetch failed');
  };
  const report = await livePreflight(
    probes({
      rhcChainId: down,
      rhcBalanceEth: down,
      arbitrumChainId: () => new Promise(() => {}), // hangs
      arbitrumBalanceEth: async () => 0,
      hyperliquidRole: async () => 'missing',
      hyperliquidDexListed: down,
    }),
    { ...expect, rhcGasReserveEth: 0.01 },
    20,
  );
  assert.deepEqual(report.fatal, []);
  const text = report.warnings.join('\n');
  assert.match(text, /Robinhood Chain RPC unreachable \(fetch failed\)/);
  assert.match(text, /Arbitrum RPC unreachable \(Arbitrum RPC: no answer within/);
  assert.match(text, /no ETH on Arbitrum/);
  assert.match(text, /no account for 0x0+a1 yet/);
  assert.match(text, /perp dex list unreachable/);

  const low = await livePreflight(probes({ rhcBalanceEth: async () => 0.004 }), expect);
  assert.deepEqual(low.fatal, []);
  assert.match(low.warnings.join('\n'), /0\.004 ETH on Robinhood Chain, below RHC_GAS_RESERVE_ETH 0\.01/);
});

test('definite misconfiguration refuses to start: wrong chain, a non-user Hyperliquid address, a missing dex', async () => {
  const report = await livePreflight(
    probes({ rhcChainId: async () => 1, arbitrumChainId: async () => 421614, hyperliquidRole: async () => 'agent', hyperliquidDexListed: async () => false }),
    expect,
  );
  assert.deepEqual(report.fatal, [
    'ROBINHOOD_RPC_URL serves chain 1, expected 4663',
    'ARBITRUM_RPC_URL serves chain 421614, expected 42161',
    '0x00000000000000000000000000000000000000a1 is a Hyperliquid agent, not a user account: the engine trades and reads positions as that address itself',
    'Hyperliquid perp dex "xyz" (HYPERLIQUID_DEX) is not listed in perpDexs',
  ]);
});
