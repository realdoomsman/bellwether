import { erc20Abi, formatEther, formatUnits } from 'viem';
import type { Balances, NetworkConfig, Wallet } from '../ports.ts';
import type { Client } from './chains.ts';
import { shortError } from './errors.ts';
import type { HlInfo } from './hyperliquid/info.ts';

/** Runs one balance read; viem errors carry the RPC URL in their message, so only the short form escapes. */
async function read<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new Error(`${what} failed: ${shortError(err)}`);
  }
}

const USDC_DECIMALS = 6;

export interface WalletDeps {
  rhc: Client;
  arbitrum: Client;
  net: NetworkConfig;
  hl: HlInfo;
}

export function createWallet({ rhc, arbitrum, net, hl }: WalletDeps): Wallet {
  const address = net.protocolAddress;
  return {
    address,

    async balances(): Promise<Balances> {
      const [rhcEth, arbEth, arbUsdc, hlDefault, hlBuilder] = await Promise.all([
        read('RHC ETH balance', () => rhc.getBalance({ address })),
        read('Arbitrum ETH balance', () => arbitrum.getBalance({ address })),
        read('Arbitrum USDC balance', () =>
          arbitrum.readContract({ address: net.contracts.arbitrumUsdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
        ),
        read('Hyperliquid account', () => hl.clearinghouse(address, null)),
        read('Hyperliquid builder-dex account', () => hl.clearinghouse(address, net.hyperliquidDex)),
      ]);
      return {
        rhcEth: Number(formatEther(rhcEth)),
        arbitrumEth: Number(formatEther(arbEth)),
        arbitrumUsdc: Number(formatUnits(arbUsdc, USDC_DECIMALS)),
        // Default perp dex (where deposits land) + the builder dex (where margin trades).
        venueEquityUsd: Number(hlDefault.marginSummary.accountValue) + Number(hlBuilder.marginSummary.accountValue),
      };
    },

    tokenBalance(token, holder = address) {
      return read(`${token} balance`, () => rhc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }));
    },
  };
}
