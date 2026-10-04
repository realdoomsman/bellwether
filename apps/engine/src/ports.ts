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
} from '@bellwether/shared';

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
   * Read-only, optional: both legs a claim would pay right now — `wei` (ETH/WETH, as `claimable`) and
   * `tokens` (the launched memecoin, which `claim` burns). Null if unknown. Absent = the claim pays ETH only.
   */
  claimablePreview?(token: Address): Promise<{ wei: bigint; tokens: bigint } | null>;
  /**
   * Claims fees to the protocol wallet and unwraps WETH. `amountWei` = gross ETH+WETH received (gas not deducted);
   * `gasWei` = gas of every tx the claim mined (claim calls, unwrap, burn), which the ledger nets out of the split.
   * Launchpad lockers also pay the memecoin side of LP fees; those tokens are burned and reported in `tokensBurned`,
   * or, when that burn fails, reported in `tokensUnburned` (still held by the protocol wallet; retry with `burnHeld`).
   * `onBroadcast` fires synchronously for each claim call once it is broadcast, before its receipt is awaited:
   * persist it there. A throw after it fired leaves that call's outcome unknown (resolve it with `lookupClaim`).
   */
  claim(token: Address, onBroadcast?: (tx: BroadcastTx) => void): Promise<ClaimResult | null>;
  /** Read-only: outcome of a claim call broadcast earlier whose receipt never came back. Absent = claims never leave one. */
  lookupClaim?(token: Address, tx: BroadcastTx): Promise<ClaimTxOutcome>;
}

export interface ClaimResult {
  amountWei: bigint;
  gasWei: bigint;
  tx: TxReceiptRef;
  tokensBurned: { amount: bigint; tx: TxReceiptRef } | null;
  tokensUnburned?: { amount: bigint; burnUnconfirmed: BroadcastTx | null } | null;
  /** A claim call broadcast after earlier ones landed whose receipt never came back: not in this result, may still land. */
  unconfirmed?: BroadcastTx | null;
}

/** On-chain outcome of a claim call (`Launchpad.lookupClaim`). */
export type ClaimTxOutcome =
  | { status: 'pending' }
  /** Never mined: its nonce was taken by another tx. */
  | { status: 'dropped' }
  | {
      status: 'mined';
      ok: boolean;
      tx: TxReceiptRef;
      gasWei: bigint;
      /** ETH + WETH the call paid the wallet (gross; 0 when reverted). */
      amountWei: bigint;
      /** Raw memecoin units the call transferred to the wallet. */
      tokens: bigint;
      /**
       * The wallet sent other txs in the same block, so the native ETH this call paid can't be told apart from
       * theirs in the block's balance change: `amountWei` then counts WETH only.
       */
      nativeUnknown: boolean;
    };

// ─── DEX (Uniswap V3 + V4 on Robinhood Chain) ────────────────────────────────
/** A tx that was broadcast but whose outcome is not known (no receipt in time, or the process stopped waiting). */
export interface BroadcastTx {
  hash: string;
  nonce: number;
}

/** On-chain outcome of a broadcast tx (`Dex.lookupTx`). */
export type TxOutcome =
  | { status: 'pending' }
  /** Never mined: its nonce was taken by another tx. */
  | { status: 'dropped' }
  | {
      status: 'mined';
      ok: boolean;
      tx: TxReceiptRef;
      gasWei: bigint;
      /** Native ETH the tx carried (spent only when `ok`). */
      valueWei: bigint;
      /** Raw `token` units the receipt transfers to the protocol wallet / to the burn address. */
      received: bigint;
      burned: bigint;
    };

export interface BuyOptions {
  /**
   * V4 pools keep no on-chain price history: the engine's rolling reference price for `token` (raw units per wei,
   * from `spotPrice` samples). A V4 buy without it is refused (`no-twap`); V3 routes use the pool's own TWAP.
   */
  referencePrice?: number;
  /** Called synchronously once the swap is broadcast, before its receipt is awaited: persist the intent here. */
  onSwapBroadcast?: (tx: BroadcastTx) => void;
}

export interface BuybackResult {
  amountInWei: bigint;
  /** Raw token units bought (credited to the protocol wallet, then burned). */
  amountOut: bigint;
  swapTx: TxReceiptRef;
  /** Null when the swap landed but the burn did not: `amountOut` is still held by the protocol wallet (retry with `burnHeld`). */
  burnTx: TxReceiptRef | null;
  /** Gas of every tx the buyback mined (observation growth, swap, burn). */
  gasWei: bigint;
  /** With `burnTx` null: a burn that was broadcast but never confirmed; it may still land (resolve with `lookupTx`). */
  burnUnconfirmed?: BroadcastTx | null;
}

export interface BurnResult {
  /** Raw units actually burned: `amount` clamped to the wallet's balance, 0 when it holds none (then `tx` is null). */
  amount: bigint;
  tx: TxReceiptRef | null;
  gasWei: bigint;
}

export interface Dex {
  /** Read-only best quote (V4 pool for Pons V2 tokens, else best V3 fee tier). Null if no pool/liquidity. */
  quote(token: Address, amountInWei: bigint): Promise<{ amountOut: bigint; feeTier: number } | null>;
  /**
   * Read-only: price (raw units per wei, fees included) of a minimal buy on `token`'s V4 pool, sampled by the engine
   * into the rolling reference `buyAndBurn` needs for V4. Null when `token` does not trade on V4.
   */
  spotPrice(token: Address): Promise<number | null>;
  /**
   * Swap native ETH for `token` and send the proceeds to the burn address. Throws `PriceGuardError` before sending
   * anything when the price looks manipulated or the swap would move it too far. Never throws once the swap landed;
   * a throw after `onSwapBroadcast` fired means its outcome is unknown (resolve it with `lookupTx`).
   */
  buyAndBurn(token: Address, amountInWei: bigint, maxSlippageBps: number, opts?: BuyOptions): Promise<BuybackResult>;
  /** Burns up to `amount` of `token` held by the protocol wallet (a buyback or claim whose burn failed). */
  burnHeld(token: Address, amount: bigint, onBroadcast?: (tx: BroadcastTx) => void): Promise<BurnResult>;
  /** Read-only: outcome of an earlier broadcast, counting `token` transfers in its receipt. */
  lookupTx(tx: BroadcastTx, token: Address): Promise<TxOutcome>;
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
  /** Margin the fill committed to the position: what actually filled / leverage (0 for reduces). */
  collateralUsedUsd: number;
  tx: TxReceiptRef;
}

/** A reduce/close fill. IOC orders can fill part of the requested size and cancel the rest. */
export interface ExitFill extends Fill {
  /** Fraction of the position held before the order that this fill closed; 1 only when the venue holds none of it any more. */
  closedFraction: number;
  /** The order filled its whole requested size. */
  complete: boolean;
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
  /**
   * Close `fraction` (0 < f <= 1) of the position in `symbol`. 1 = full close. A venue may close more than
   * asked (e.g. the whole position when the partial size is below its minimum order) or, on a partial fill,
   * less: `closedFraction` reports what was actually closed.
   */
  reduce(symbol: string, fraction: number, maxSlippageBps: number): Promise<ExitFill>;
  /**
   * Move any idle collateral into tradable margin (e.g. Arbitrum USDC → HL). Returns USD moved, and the deposit
   * this call sent that the venue had not credited yet when it returned (its USD is in neither wallet nor venue).
   */
  topUpMargin(): Promise<{ movedUsd: number; txs: TxReceiptRef[]; uncredited?: { usd: number; tx: TxReceiptRef } }>;
  /** Whether the venue has credited a deposit `topUpMargin` reported `uncredited`, sent at `sentAt` (ms). */
  depositCredited?(tx: TxReceiptRef, sentAt: number): Promise<boolean>;
}

// ─── Bridge (RHC ETH → Arbitrum USDC) ────────────────────────────────────────
/** Callbacks that let the caller persist a deposit intent before it is signed and its hash once broadcast. */
export interface BridgeHooks {
  /** Called after the route is validated and before the deposit is signed; `requestId` finds the order later. */
  prepared?(deposit: { requestId: string; expectedUsdc: number }): void;
  /** Called as soon as the deposit tx is broadcast, before its receipt. */
  broadcast?(tx: TxReceiptRef, nonce?: number): void;
}

/** Where a deposit whose `ethToUsdc` never returned stands. */
export type BridgeDepositStatus =
  /** Broadcast or in flight at the bridge, not settled on the origin chain yet: wait. */
  | { state: 'pending' }
  /** Mined successfully: the ETH left the wallet. `filled`: the bridge reports the output delivered on the destination. */
  | { state: 'landed'; tx: TxReceiptRef; gasWei: bigint; filled?: boolean }
  /** Mined but reverted, or refunded by the bridge: the ETH is back in the wallet, only gas was spent. */
  | { state: 'reverted' | 'refunded'; tx: TxReceiptRef; gasWei: bigint }
  /** Broadcast, but its nonce was mined by another tx and it has no receipt: it never will. Trust after a grace (RPC lag). */
  | { state: 'dropped' }
  /** Neither the chain nor the bridge knows a deposit for this request. */
  | { state: 'unknown' };

export interface Bridge {
  quote(amountWei: bigint): Promise<{ expectedUsdc: number; impactPct: number } | null>;
  /** Refuses (throws) a route whose impact exceeds `maxImpactPct` or that promises less than `minUsdc`. */
  ethToUsdc(
    amountWei: bigint,
    maxImpactPct: number,
    minUsdc: number,
    hooks?: BridgeHooks,
  ): Promise<{ expectedUsdc: number; tx: TxReceiptRef; gasWei: bigint }>;
  /** Looks up a deposit by the `requestId` from `prepared` and, when recorded, the hash (and nonce) from `broadcast`. */
  depositStatus(deposit: { requestId: string; hash: string | null; nonce?: number | null }): Promise<BridgeDepositStatus>;
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

/** Read-only startup checks of the live networks (`createLiveProbes`); each call is one request. */
export interface LiveProbes {
  rhcChainId(): Promise<number>;
  arbitrumChainId(): Promise<number>;
  /** Protocol wallet's native balance, ETH. */
  rhcBalanceEth(): Promise<number>;
  arbitrumBalanceEth(): Promise<number>;
  /** Hyperliquid `userRole` of the protocol wallet: `missing`, `user`, `agent`, `vault` or `subAccount`. */
  hyperliquidRole(): Promise<string>;
  /** Whether the configured HIP-3 dex is listed in `perpDexs`. */
  hyperliquidDexListed(): Promise<boolean>;
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
    /** Uniswap V4: Pons V2 tokens graduate into V4 pools. */
    uniswapV4Quoter: Address;
    uniswapV4StateView: Address;
    uniswapUniversalRouter: Address;
    arbitrumUsdc: Address;
    ponsFactory: Address;
    ponsLocker: Address;
    ponsV2Factory: Address;
    ponsV2Hook: Address;
    ponsV2FeeEscrow: Address;
    launchhoodFactory: Address;
    launchhoodLocker: Address | null;
    hyperliquidBridge: Address;
  };
  /** First block to scan for Pons V2 fee-escrow credits (the V2 factory's deployment). */
  ponsV2FromBlock: number;
}

/** Additional settings for live (signing) integrations. */
export interface LiveConfig extends NetworkConfig {
  privateKey: Hex;
  relayApiUrl: string;
  /** Relay depository contracts on RHC a bridge deposit may target (pinned, not taken from Relay's API). */
  relayDepositContracts: Address[];
  /** Never let the RHC wallet drop below this (gas). */
  minRhcGasEth: number;
  /** Refuse a buyback whose execution price is worse than the pool's TWAP by more than this. */
  buybackMaxTwapDeviationBps: number;
  /** Refuse a buyback whose own price impact exceeds this. */
  buybackMaxPriceImpactBps: number;
}
