/**
 * Integration factories: the only module engine core imports from `src/integrations`.
 * Read-only integrations talk to the real networks but hold no key: every write throws ReadOnlyError.
 */
import { parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Integrations, LiveConfig, NetworkConfig } from '../ports.ts';
import { createChainClients, createSigners } from './chains.ts';
import type { Client } from './chains.ts';
import { createDiscovery } from './discovery.ts';
import { HlInfo } from './hyperliquid/info.ts';
import { createHyperliquidVenue } from './hyperliquid/venue.ts';
import type { HlTrader } from './hyperliquid/venue.ts';
import { createLaunchpads } from './launchpads.ts';
import { createPriceFeed } from './prices.ts';
import { createRelayBridge, DEFAULT_RELAY_API_URL, DEFAULT_RELAY_DEPOSIT_CONTRACTS } from './relay.ts';
import { createTokenData } from './tokendata.ts';
import { createTxSender } from './tx.ts';
import type { TxSender } from './tx.ts';
import { createUniswap } from './uniswap.ts';
import type { PriceGuardLimits } from './uniswap.ts';
import { createWallet } from './wallet.ts';

export { PriceGuardError, ReadOnlyError } from './errors.ts';
export { TWAP_WINDOW_SEC } from './uniswap.ts';
export { createLiveProbes } from './probes.ts';

interface Signing {
  rhcSender: TxSender;
  trader: HlTrader;
  relayApiUrl: string;
  relayDepositContracts: LiveConfig['relayDepositContracts'];
  buybackLimits: PriceGuardLimits;
}

function build(net: NetworkConfig, clients: { rhc: Client; arbitrum: Client }, signing: Signing | null): Integrations {
  const { rhc, arbitrum } = clients;
  const hl = new HlInfo(net.hyperliquidApiUrl);
  const sender = signing?.rhcSender ?? null;
  const { launchpads, identify } = createLaunchpads({ rhc, net, sender });
  return {
    launchpads,
    dex: createUniswap({ rhc, net, sender, limits: signing?.buybackLimits ?? null }),
    venues: [createHyperliquidVenue({ info: hl, dex: net.hyperliquidDex, user: net.protocolAddress, trader: signing?.trader ?? null })],
    bridge: createRelayBridge({
      net,
      apiUrl: signing?.relayApiUrl ?? DEFAULT_RELAY_API_URL,
      depositContracts: signing?.relayDepositContracts ?? DEFAULT_RELAY_DEPOSIT_CONTRACTS,
      sender,
    }),
    prices: createPriceFeed(hl, net.hyperliquidDex),
    tokenData: createTokenData(net),
    wallet: createWallet({ rhc, arbitrum, net, hl }),
    discovery: createDiscovery({ rhc, net, identify }),
  };
}

/** Real networks, reads only. Used by paper mode (wrapped with simulated writes) and diagnostics. */
export function createReadOnlyIntegrations(net: NetworkConfig): Integrations {
  return build(net, createChainClients(net), null);
}

/** Real networks with signed writes from the protocol wallet. */
export function createLiveIntegrations(cfg: LiveConfig): Integrations {
  const account = privateKeyToAccount(cfg.privateKey);
  if (account.address.toLowerCase() !== cfg.protocolAddress.toLowerCase()) {
    throw new Error(`private key controls ${account.address}, but protocolAddress is ${cfg.protocolAddress}`);
  }
  const clients = createChainClients(cfg);
  const signers = createSigners(cfg, account);
  return build(cfg, clients, {
    rhcSender: createTxSender({
      chain: 'rhc',
      client: clients.rhc,
      signer: signers.rhc,
      minBalanceWei: parseEther(cfg.minRhcGasEth.toFixed(18)),
    }),
    trader: {
      account,
      arbitrum: clients.arbitrum,
      arbitrumSender: createTxSender({ chain: 'arbitrum', client: clients.arbitrum, signer: signers.arbitrum }),
      arbitrumUsdc: cfg.contracts.arbitrumUsdc,
      bridge: cfg.contracts.hyperliquidBridge,
    },
    relayApiUrl: cfg.relayApiUrl,
    relayDepositContracts: cfg.relayDepositContracts,
    buybackLimits: { maxTwapDeviationBps: cfg.buybackMaxTwapDeviationBps, maxPriceImpactBps: cfg.buybackMaxPriceImpactBps },
  });
}
