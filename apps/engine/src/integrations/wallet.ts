import { erc20Abi, formatEther, formatUnits } from 'viem';
import type { Balances, NetworkConfig, Wallet } from '../ports.ts';
import type { Client } from './chains.ts';
import type { HlInfo } from './hyperliquid/info.ts';

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
        rhc.getBalance({ address }),
        arbitrum.getBalance({ address }),
        arbitrum.readContract({ address: net.contracts.arbitrumUsdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
        hl.clearinghouse(address, null),
        hl.clearinghouse(address, net.hyperliquidDex),
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
      return rhc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
    },
  };
}
