/**
 * HTTP API contract between @stepup/engine and @stepup/web.
 * All routes are under `/api`. All amounts are JSON numbers in the unit named by the field
 * suffix (Eth, Usd, Pct as fraction 0.12 = 12%). Timestamps are unix milliseconds.
 * Errors: non-2xx with body `ApiError`.
 */
import type { ChainKey } from './chains.ts';
import type { LaunchpadId } from './launchpads.ts';
import type { MarketSession } from './session.ts';
import type { StrategyId } from './strategies.ts';

export type Address = `0x${string}`;
export type EngineMode = 'paper' | 'live';
export type Side = 'long' | 'short';
export type TokenStatus = 'pending' | 'active' | 'paused' | 'rejected' | 'retired';
export type VenueId = 'hyperliquid' | 'paper';
export type WorkerId =
  | 'claimer'
  | 'treasury'
  | 'trader'
  | 'guardian'
  | 'buyback'
  | 'discovery'
  | 'reconciler';

export interface ApiError {
  error: string;
  /** Machine-readable code, e.g. `invalid_address`, `already_registered`, `wallet_not_configured`. */
  code: string;
  details?: Record<string, unknown>;
}

/** On-chain (or venue) reference proving an action happened. */
export interface TxRef {
  chain: ChainKey;
  hash: string;
  /** Null in paper mode; paper refs are prefixed `paper:` and are never links. */
  url: string | null;
}

// ─── GET /api/health ─────────────────────────────────────────────────────────
export interface HealthResponse {
  ok: true;
  mode: EngineMode;
  version: string;
  uptimeSec: number;
}

// ─── GET /api/status ─────────────────────────────────────────────────────────
export interface WorkerHealth {
  id: WorkerId;
  label: string;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  nextRunAt: number | null;
  running: boolean;
}

export interface VenueStatus {
  id: VenueId;
  name: string;
  active: boolean;
  paused: boolean;
  pausedReason: string | null;
  maxLeverage: number;
}

export interface StatusResponse {
  mode: EngineMode;
  /** True when a signer is loaded and live execution is allowed. Always false in paper mode. */
  armed: boolean;
  /** Global kill switch: when on, no new positions or buybacks; exits still run. */
  killSwitch: boolean;
  session: MarketSession;
  venue: { active: VenueId | null; venues: VenueStatus[] };
  workers: WorkerHealth[];
  /** Null until the operator configures the protocol wallet; launching/registration is disabled meanwhile. */
  protocolWallet: Address | null;
  protocolToken: Address | null;
  burnMode: 'burn';
  version: string;
  startedAt: number;
}

// ─── GET /api/stats ──────────────────────────────────────────────────────────
export interface StatsResponse {
  tokensActive: number;
  tokensPending: number;
  feesClaimedEth: number;
  /** ETH spent on buybacks, all tokens incl. the protocol token. */
  buybackEth: number;
  buybackCount: number;
  /** USD value (at time of burn) of everything burned. */
  burnedUsd: number;
  protocolBurned: number;
  tradingEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  trades: number;
  wins: number;
  losses: number;
  openPositions: number;
  /** Rolling 30 days of daily points for sparklines. */
  history: { day: string; feesEth: number; buybackEth: number; realizedPnlUsd: number }[];
}

// ─── Tokens ──────────────────────────────────────────────────────────────────
/** Why the engine is (not) trading this token right now; shown verbatim-ish in UI. */
export type DecisionVerdict =
  | 'pending-review'
  | 'collecting-fees'
  | 'below-minimum'
  | 'waiting-session'
  | 'waiting-signal'
  | 'venue-paused'
  | 'kill-switch'
  | 'daily-loss-limit'
  | 'in-position'
  | 'burn-only'
  | 'paused';

export interface Decision {
  verdict: DecisionVerdict;
  /** Human sentence, e.g. "Signal 32/60 on AAPL — waiting for a better entry". */
  message: string;
  at: number;
  signalScore?: number;
  signalThreshold?: number;
}

export interface TokenBook {
  feesClaimedEth: number;
  /** Unspent budgets. */
  tradingBudgetUsd: number;
  tokenBuybackBudgetEth: number;
  protocolBuybackBudgetEth: number;
  /** Collateral currently in an open position attributed to this token. */
  deployedUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  buybackEth: number;
  tokensBurned: number;
  /** Fraction of total supply burned so far, 0..1. */
  supplyBurnedPct: number;
  trades: number;
  wins: number;
}

export interface TokenSummary {
  address: Address;
  name: string;
  symbol: string;
  image: string | null;
  launchpad: LaunchpadId;
  status: TokenStatus;
  market: string;
  side: Side;
  strategy: StrategyId;
  maxLeverage: number;
  createdAt: number;
  book: TokenBook;
  decision: Decision;
  /** Live DEX price if known. */
  priceUsd: number | null;
  change24hPct: number | null;
}

export interface TokenDetailResponse {
  token: TokenSummary & {
    deployer: Address | null;
    totalSupply: number | null;
    decimals: number;
    rejectedReason: string | null;
  };
  position: PositionView | null;
  trades: TradeView[];
  activity: ActivityEvent[];
}

export interface TokensResponse {
  tokens: TokenSummary[];
}

// POST /api/tokens  (register)
export interface RegisterRequest {
  address: Address;
  launchpad: LaunchpadId;
  market: string;
  side: Side;
  strategy: StrategyId;
  maxLeverage: number;
}
export interface RegisterResponse {
  token: TokenSummary;
  /** True if it went straight to active; false if queued for review. */
  activated: boolean;
}

// GET /api/tokens/:address/verify?launchpad=  (dry-run check used by the launch wizard)
export interface VerifyCheck {
  id: 'contract' | 'launchpad' | 'fee-recipient' | 'impersonation' | 'not-registered';
  label: string;
  ok: boolean;
  detail: string;
}
export interface VerifyResponse {
  ok: boolean;
  checks: VerifyCheck[];
  token: { name: string; symbol: string; image: string | null; deployer: Address | null } | null;
}

// Creator settings: the token deployer proves ownership with an EIP-191 personal_sign.
// GET /api/tokens/:address/settings/challenge -> SettingsChallenge
// POST /api/tokens/:address/settings  body SettingsUpdateRequest -> TokenSummary
export interface SettingsChallenge {
  message: string;
  nonce: string;
  expiresAt: number;
  deployer: Address;
}
export interface SettingsUpdateRequest {
  nonce: string;
  signature: `0x${string}`;
  strategy?: StrategyId;
  market?: string;
  side?: Side;
  maxLeverage?: number;
}

// ─── Positions & trades ──────────────────────────────────────────────────────
export interface PositionShare {
  token: Address;
  symbol: string;
  /** Fraction of the pooled position owned by this token, 0..1. */
  share: number;
  collateralUsd: number;
}

export interface PositionView {
  id: string;
  venue: VenueId;
  market: string;
  side: Side;
  leverage: number;
  sizeUsd: number;
  collateralUsd: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number | null;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  stage: 'open' | 'breakeven' | 'tp1' | 'tp2' | 'trailing';
  stopPrice: number | null;
  openedAt: number;
  shares: PositionShare[];
}

export interface PositionsResponse {
  positions: PositionView[];
}

export type TradeAction = 'open' | 'reduce' | 'close' | 'stop' | 'liquidated';
export interface TradeView {
  id: string;
  positionId: string;
  venue: VenueId;
  market: string;
  side: Side;
  action: TradeAction;
  /** Why the engine did it, e.g. "take-profit 1", "stop -30%", "signal flip". */
  reason: string;
  sizeUsd: number;
  price: number;
  realizedPnlUsd: number;
  feeUsd: number;
  at: number;
  tx: TxRef | null;
}
export interface TradesResponse {
  trades: TradeView[];
}

// ─── Activity (unified event log; also the SSE `activity` payload) ───────────
export type ActivityKind =
  | 'registered'
  | 'activated'
  | 'claim'
  | 'bridge'
  | 'open'
  | 'reduce'
  | 'close'
  | 'stop'
  | 'liquidated'
  | 'buyback'
  | 'risk'
  | 'settings'
  | 'kill-switch';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  at: number;
  token: Address | null;
  tokenSymbol: string | null;
  /** One-line human summary. */
  title: string;
  amountEth?: number;
  amountUsd?: number;
  tokensBurned?: number;
  market?: string;
  txs: TxRef[];
}
export interface ActivityResponse {
  events: ActivityEvent[];
  /** Pass as `?before=` to page older events; null when exhausted. */
  nextBefore: number | null;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
export type LeaderboardBy = 'burned' | 'pnl' | 'fees';
export interface LeaderboardResponse {
  by: LeaderboardBy;
  rows: (TokenSummary & { rank: number })[];
}

// ─── Markets ─────────────────────────────────────────────────────────────────
export interface MarketView {
  symbol: string;
  name: string;
  sector: string;
  available: boolean;
  maxLeverage: number;
  price: number | null;
  change24hPct: number | null;
  /** Current entry signal score -100..100 and direction hint. */
  signal: { score: number; bias: 'long' | 'short' | 'wait' } | null;
  tokens: number;
}
export interface MarketsResponse {
  venue: VenueId | null;
  markets: MarketView[];
}

export type CandleInterval = '5m' | '15m' | '1h' | '1d';
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
// GET /api/markets/:symbol/candles?interval=
export interface CandlesResponse {
  symbol: string;
  interval: CandleInterval;
  candles: Candle[];
}

// GET /api/tokens/:address/candles?interval=  (token DEX chart, may be empty pre-graduation)
export interface TokenCandlesResponse {
  address: Address;
  interval: CandleInterval;
  candles: Candle[];
}

// ─── Proof of reserves / transparency ────────────────────────────────────────
export interface WalletBalance {
  chain: ChainKey;
  address: Address;
  url: string | null;
  asset: string;
  amount: number;
  usd: number | null;
}
export interface LedgerAccountView {
  account: string;
  label: string;
  unit: 'ETH' | 'USD';
  balance: number;
}
export interface ReconciliationItem {
  asset: string;
  chain: ChainKey;
  /** What the ledger says we should hold. */
  expected: number;
  /** What we actually hold (on-chain / venue). */
  actual: number;
  drift: number;
  ok: boolean;
}
export interface ProofResponse {
  mode: EngineMode;
  wallets: WalletBalance[];
  ledger: LedgerAccountView[];
  reconciliation: { checkedAt: number | null; items: ReconciliationItem[] };
  burnAddress: Address;
}

// ─── Static-ish config for the UI ────────────────────────────────────────────
export interface ConfigResponse {
  mode: EngineMode;
  /** Null until the operator configures the protocol wallet; launching/registration is disabled meanwhile. */
  protocolWallet: Address | null;
  protocolToken: Address | null;
  autoApprove: boolean;
  minCollateralUsd: number;
  venueMaxLeverage: number;
}

// ─── Server-sent events: GET /api/stream ─────────────────────────────────────
export type StreamEvent =
  | { type: 'activity'; data: ActivityEvent }
  | { type: 'stats'; data: StatsResponse }
  | { type: 'positions'; data: PositionsResponse }
  | { type: 'status'; data: StatusResponse };
