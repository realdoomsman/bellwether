import { createPublicClient, createWalletClient, defineChain, fallback, http } from 'viem';
import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem';
import { arbitrum } from 'viem/chains';
import { CHAINS } from '@bellwether/shared';
import type { NetworkConfig } from '../ports.ts';

/** Generous: full-history `eth_getLogs` filtered by address + topic takes a few seconds on the public RHC RPC. */
const RPC_TIMEOUT_MS = 30_000;
/** Public RPCs answer bursts with HTTP 429; viem retries those with exponential backoff (0.4s, 0.8s, 1.6s, 3.2s). */
const RPC_RETRY = { retryCount: 4, retryDelay: 400 };
/** Transport options of every engine RPC client (exported so proofs measure the same client). */
export const RPC_OPTIONS = { timeout: RPC_TIMEOUT_MS, ...RPC_RETRY };

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export type Client = PublicClient<Transport, Chain>;
export type Signer = WalletClient<Transport, Chain, Account>;

export function robinhoodChain(rpcUrl: string): Chain {
  return defineChain({
    id: CHAINS.rhc.chainId!,
    name: CHAINS.rhc.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Blockscout', url: CHAINS.rhc.explorer } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

interface Endpoint {
  chain: Chain;
  transport: Transport;
}

/** The primary RPC, then each fallback in order (viem moves on once a transport's own retries are spent). */
function transportOf(primary: string, fallbacks: string[]): Transport {
  if (fallbacks.length === 0) return http(primary, RPC_OPTIONS);
  return fallback([primary, ...fallbacks].map((u) => http(u, RPC_OPTIONS)));
}

function endpoints(net: NetworkConfig): { rhc: Endpoint; arbitrum: Endpoint } {
  return {
    rhc: { chain: robinhoodChain(net.rhcRpcUrl), transport: transportOf(net.rhcRpcUrl, net.rhcRpcFallbackUrls) },
    arbitrum: { chain: arbitrum, transport: transportOf(net.arbitrumRpcUrl, net.arbitrumRpcFallbackUrls) },
  };
}

export function createChainClients(net: NetworkConfig): { rhc: Client; arbitrum: Client } {
  const ep = endpoints(net);
  return { rhc: createPublicClient(ep.rhc), arbitrum: createPublicClient(ep.arbitrum) };
}

export function createSigners(net: NetworkConfig, account: Account): { rhc: Signer; arbitrum: Signer } {
  const ep = endpoints(net);
  return { rhc: createWalletClient({ ...ep.rhc, account }), arbitrum: createWalletClient({ ...ep.arbitrum, account }) };
}
