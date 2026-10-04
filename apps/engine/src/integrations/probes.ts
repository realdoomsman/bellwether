/** Read-only startup probes of the live networks, built on the same client factories the integrations use. */
import { formatEther } from 'viem';
import type { LiveProbes, NetworkConfig } from '../ports.ts';
import { createChainClients } from './chains.ts';
import { HlInfo } from './hyperliquid/info.ts';

export function createLiveProbes(net: NetworkConfig): LiveProbes {
  const { rhc, arbitrum } = createChainClients(net);
  const hl = new HlInfo(net.hyperliquidApiUrl);
  const address = net.protocolAddress;
  return {
    rhcChainId: () => rhc.getChainId(),
    arbitrumChainId: () => arbitrum.getChainId(),
    rhcBalanceEth: async () => Number(formatEther(await rhc.getBalance({ address }))),
    arbitrumBalanceEth: async () => Number(formatEther(await arbitrum.getBalance({ address }))),
    hyperliquidRole: async () => (await hl.post<{ role: string }>({ type: 'userRole', user: address })).role,
    hyperliquidDexListed: async () => (await hl.post<({ name: string } | null)[]>({ type: 'perpDexs' })).some((d) => d?.name === net.hyperliquidDex),
  };
}
