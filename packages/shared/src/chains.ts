export type ChainKey = 'rhc' | 'arbitrum' | 'hyperliquid';

export interface ChainInfo {
  key: ChainKey;
  name: string;
  chainId: number | null;
  explorer: string;
}

export const CHAINS: Record<ChainKey, ChainInfo> = {
  rhc: { key: 'rhc', name: 'Robinhood Chain', chainId: 4663, explorer: 'https://robinhoodchain.blockscout.com' },
  arbitrum: { key: 'arbitrum', name: 'Arbitrum One', chainId: 42161, explorer: 'https://arbiscan.io' },
  hyperliquid: { key: 'hyperliquid', name: 'Hyperliquid', chainId: null, explorer: 'https://app.hyperliquid.xyz/explorer' },
};

export function txUrl(chain: ChainKey, hash: string): string {
  return chain === 'hyperliquid'
    ? `${CHAINS.hyperliquid.explorer}/tx/${hash}`
    : `${CHAINS[chain].explorer}/tx/${hash}`;
}

export function addressUrl(chain: ChainKey, address: string): string {
  return chain === 'hyperliquid'
    ? `${CHAINS.hyperliquid.explorer}/address/${address}`
    : `${CHAINS[chain].explorer}/address/${address}`;
}
