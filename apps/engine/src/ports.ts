/**
 * Ports: the boundary between engine core (ledger, workers, API) and the outside world
 * (chains, launchpads, DEX, perp venues, bridges, market data).
 *
 * - `src/integrations/**` implements these against real networks (live + read-only).
 * - `src/paper/**` implements the write-side ports as simulations for ENGINE_MODE=paper.
 * Core code MUST depend only on these interfaces, never on integration modules directly
 * (except the factories in `src/integrations/index.ts`).
 */
import type {
  Address,
  Candle,
  CandleInterval,
  ChainKey,
  LaunchpadId,
  Side,
  VenueId,
} from '@floor/shared';

export type Hex = `0x${string}`;

export interface TxReceiptRef {
  chain: ChainKey;
  /** Real tx hash, or `paper:<id>` in paper mode. */
  hash: string;
}

// ─── Launchpads (Robinhood Chain) ────────────────────────────────────────────
export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  image: string | null;
}

export type LaunchpadVerifyFailure =
  | 'no-contract'
  | 'wrong-launchpad'
  | 'fee-recipient-mismatch'
  | 'lookup-failed';

export interface LaunchpadVerifyResult {
  ok: boolean;
  failure: LaunchpadVerifyFailure | null;
  /** Human detail for UI, e.g. "Creator wallet is 0xabc…, expected 0x2cd…". */
  detail: string;
  /** EOA that sent the token creation tx (the real creator; used for settings auth). */
  deployer: Address | null;
  metadata: TokenMetadata | null;
}

export interface Launchpad {
  id: LaunchpadId;
  /** Read-only: token exists, was deployed by this launchpad, and routes creator fees to the protocol wallet. */
  verify(token: Address): Promise<LaunchpadVerifyResult>;
  /** Read-only: unclaimed creator fees in wei (ETH or WETH). Null if unknown. */
  claimable(token: Address): Promise<bigint | null>;
  /**
   * Claims fees to the protocol wallet and unwraps WETH. `amountWei` = gross ETH+WETH received (gas not deducted).
   * Launchpad lockers also pay the memecoin side of LP fees; those tokens are burned and reported in `tokensBurned`.
   */
  claim(token: Address): Promise<{
    amountWei: bigint;
    tx: TxReceiptRef;
    tokensBurned: { amount: bigint; tx: TxReceiptRef } | null;
  } | null>;
}

// ─── DEX (Uniswap V3 on Robinhood Chain) ─────────────────────────────────────
export interface BuybackResult {
  amountInWei: bigint;
  /** Raw token units bought (and burned). */
  amountOut: bigint;
  swapTx: TxReceiptRef;
  burnTx: TxReceiptRef;
}

export interface Dex {
  /** Read-only best quote across fee tiers. Null if no pool/liquidity. */
  quote(token: Address, amountInWei: bigint): Promise<{ amountOut: bigint; feeTier: number } | null>;
  /** Swap native ETH for `token` and send the proceeds to the burn address. */
  buyAndBurn(token: Address, amountInWei: bigint, maxSlippageBps: number): Promise<BuybackResult>;
}

// ─── Perp venues ─────────────────────────────────────────────────────────────
export interface VenueMarket {
  symbol: string;
  /** Venue-native identifier, e.g. `xyz:AAPL`. */
  venueSymbol: string;
  maxLeverage: number;
  /** Venue says orders can execute right now. */
  open: boolean;
  markPrice: number;
}

export interface VenuePosition {
  symbol: string;
  side: Side;
  sizeUsd: number;
  collateralUsd: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  unrealizedPnlUsd: number;
  liquidationPrice: number | null;
}

export interface Fill {
  symbol: string;
  side: Side;
  /** Notional filled, USD. */
  sizeUsd: number;
  price: number;
  feeUsd: number;
  /** Venue-reported realized PnL for reduce/close fills (0 for opens). */
  realizedPnlUsd: number;
  /** Collateral returned to free margin by a reduce/close (0 for opens). */
  collateralReleasedUsd: number;
  tx: TxReceiptRef;
}

export interface OpenRequest {
  symbol: string;
  side: Side;
  collateralUsd: number;
  leverage: number;
  maxSlippageBps: number;
}

export interface Venue {
  id: VenueId;
  name: string;
  health(): Promise<{ paused: boolean; reason: string | null }>;
  markets(): Promise<VenueMarket[]>;
  freeCollateralUsd(): Promise<number>;
  positions(): Promise<VenuePosition[]>;
  open(req: OpenRequest): Promise<Fill>;
  /** Close `fraction` (0 < f <= 1) of the position in `symbol`. 1 = full close. */
  reduce(symbol: string, fraction: number, maxSlippageBps: number): Promise<Fill>;
  /** Move any idle collateral into tradable margin (e.g. Arbitrum USDC → HL). Returns USD moved. */
  topUpMargin(): Promise<{ movedUsd: number; txs: TxReceiptRef[] }>;
}

// ─── Bridge (RHC ETH → Arbitrum USDC) ────────────────────────────────────────
export interface Bridge {
  quote(amountWei: bigint): Promise<{ expectedUsdc: number; impactPct: number } | null>;
  ethToUsdc(amountWei: bigint, maxImpactPct: number): Promise<{ expectedUsdc: number; tx: TxReceiptRef }>;
}

// ─── Market data (read-only) ─────────────────────────────────────────────────
export interface PriceFeed {
  /** Stock candles, newest last. */
  candles(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]>;
  quote(symbol: string): Promise<{ price: number; change24hPct: number } | null>;
  ethUsd(): Promise<number>;
}

export interface TokenMarketData {
  priceUsd: number | null;
  change24hPct: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
}

export interface TokenData {
  market(token: Address): Promise<TokenMarketData | null>;
  candles(token: Address, interval: CandleInterval, limit: number): Promise<Candle[]>;
}

// ─── Wallet / balances (read-only) ───────────────────────────────────────────
export interface Balances {
  rhcEth: number;
  arbitrumEth: number;
  arbitrumUsdc: number;
  venueEquityUsd: number;
}

export interface Wallet {
  address: Address;
  balances(): Promise<Balances>;
  /** Raw ERC-20 balance of `holder` (defaults to protocol wallet). */
  tokenBalance(token: Address, holder?: Address): Promise<bigint>;
}

// ─── Discovery (read-only) ───────────────────────────────────────────────────
export interface Discovery {
  /**
   * Scan RHC logs from `fromBlock` for tokens whose launch referenced the protocol wallet.
   * Returns candidate token addresses (unverified) and the block scanned up to.
   */
  scan(fromBlock: bigint | null): Promise<{ candidates: { token: Address; launchpad: LaunchpadId }[]; toBlock: bigint }>;
}

// ─── Aggregate ───────────────────────────────────────────────────────────────
export interface Integrations {
  launchpads: Record<LaunchpadId, Launchpad>;
  dex: Dex;
  /** Ordered by preference; the router picks the first healthy one. */
  venues: Venue[];
  bridge: Bridge;
  prices: PriceFeed;
  tokenData: TokenData;
  wallet: Wallet;
  discovery: Discovery;
}

/** Read-only network settings needed by both live and paper integrations. */
export interface NetworkConfig {
  protocolAddress: Address;
  rhcRpcUrl: string;
  arbitrumRpcUrl: string;
  blockscoutUrl: string;
  geckoterminalUrl: string;
  geckoterminalNetwork: string;
  hyperliquidApiUrl: string;
  /** HIP-3 builder dex name for equity perps on Hyperliquid, e.g. `xyz`. */
  hyperliquidDex: string;
  contracts: {
    weth: Address;
    uniswapRouter: Address;
    uniswapQuoter: Address | null;
    arbitrumUsdc: Address;
    ponsFactory: Address;
    ponsLocker: Address;
    launchhoodFactory: Address;
    launchhoodLocker: Address | null;
    hyperliquidBridge: Address;
  };
}

/** Additional settings for live (signing) integrations. */
export interface LiveConfig extends NetworkConfig {
  privateKey: Hex;
  relayApiUrl: string;
  /** Never let the RHC wallet drop below this (gas). */
  minRhcGasEth: number;
}
