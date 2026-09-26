/**
 * DEMO_SEED (paper only): a handful of synthetic tokens so a fresh paper engine has life.
 * They are stored with `demo = 1`, use deterministic fake addresses, accrue synthetic creator
 * fees and trade against a synthetic constant-product pool. Everything they produce is paper.
 */
import { getAddress, keccak256, toHex } from 'viem';
import { STRATEGIES, type Address, type LaunchpadId, type StrategyId } from '@stepup/shared';
import { kvGet, kvSet, type Db } from '../db.ts';
import { activity, type Engine } from '../engine.ts';
import { decision, getToken, insertToken } from '../tokens.ts';

const WEI = 10n ** 18n;
export const DEMO_SUPPLY = 1_000_000_000n * WEI;
/** Synthetic claims never exceed this much accrual, so a long-idle engine does not dump a huge claim. */
const MAX_ACCRUAL_MINUTES = 60;

interface DemoSpec {
  name: string;
  symbol: string;
  market: string;
  strategy: StrategyId;
  launchpad: LaunchpadId;
  pending?: boolean;
}

const DEMO_TOKENS: readonly DemoSpec[] = [
  { name: 'Tendie Tower', symbol: 'TENDIE', market: 'AAPL', strategy: 'balanced', launchpad: 'pons' },
  { name: 'Gigawatt Goose', symbol: 'GOOSE', market: 'TSLA', strategy: 'degen', launchpad: 'launchhood' },
  { name: 'Silicon Frog', symbol: 'SFROG', market: 'NVDA', strategy: 'degen', launchpad: 'pons' },
  { name: 'Clippy Cash', symbol: 'CLIPPY', market: 'MSFT', strategy: 'steady', launchpad: 'pons' },
  { name: 'Feather Fund', symbol: 'FTHR', market: 'HOOD', strategy: 'balanced', launchpad: 'launchhood' },
  { name: 'Prime Pigeon', symbol: 'PIGEON', market: 'AAPL', strategy: 'steady', launchpad: 'pons' },
  { name: 'Ash Heap', symbol: 'ASH', market: 'AAPL', strategy: 'burn', launchpad: 'launchhood' },
  { name: 'Laser Otter', symbol: 'OTTER', market: 'PLTR', strategy: 'balanced', launchpad: 'pons', pending: true },
];

function seedHash(label: string): bigint {
  return BigInt(keccak256(toHex(label)));
}

export function demoAddress(i: number): Address {
  return getAddress(`0x${(seedHash(`demo-token-${i}`) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`);
}

function demoDeployer(i: number): Address {
  return getAddress(`0x${(seedHash(`demo-deployer-${i}`) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`);
}

/** Inserts the demo tokens that do not exist yet. Idempotent. */
export function seedDemoTokens(engine: Engine): number {
  let added = 0;
  engine.db.transaction(() => {
    DEMO_TOKENS.forEach((spec, i) => {
      const address = demoAddress(i);
      if (getToken(engine.db, address)) return;
      const at = engine.clock();
      const status = spec.pending ? 'pending' : 'active';
      insertToken(engine.db, {
        address,
        name: spec.name,
        symbol: spec.symbol,
        image: null,
        launchpad: spec.launchpad,
        status,
        market: spec.market,
        side: 'long',
        strategy: spec.strategy,
        maxLeverage: STRATEGIES[spec.strategy].maxLeverage,
        deployer: demoDeployer(i),
        totalSupply: DEMO_SUPPLY,
        decimals: 18,
        autoDiscovered: false,
        demo: true,
        rejectedReason: null,
        decision:
          status === 'active'
            ? decision('collecting-fees', 'Active — waiting for the first creator fee claim', at)
            : decision('pending-review', 'Registered — waiting for review before the engine touches it', at),
        createdAt: at,
        updatedAt: at,
      });
      const token = { address, symbol: spec.symbol };
      activity(engine, { kind: 'registered', token, title: `Registered $${spec.symbol} (${spec.name}) [paper demo]`, market: spec.market });
      if (status === 'active') activity(engine, { kind: 'activated', token, title: `$${spec.symbol} is live, trading ${spec.market}`, market: spec.market });
      added++;
    });
  });
  return added;
}

// ─── synthetic fees ──────────────────────────────────────────────────────────
interface ClaimState {
  lastClaimAt: number;
}

/** Deterministic per-token fee rate between 0.0005 and 0.0024 ETH per minute. */
function feeRateWeiPerMinute(token: Address): bigint {
  const h = seedHash(`fees:${token.toLowerCase()}`);
  return (5n + (h % 20n)) * 10n ** 14n;
}

export function demoClaimable(db: Db, token: Address, now: number): bigint {
  const state = kvGet<ClaimState>(db, `paper.demo_claim.${token}`);
  const since = state?.lastClaimAt ?? getToken(db, token)?.createdAt ?? now;
  const minutes = Math.min(MAX_ACCRUAL_MINUTES, Math.max(0, (now - since) / 60_000));
  return (feeRateWeiPerMinute(token) * BigInt(Math.floor(minutes * 1000))) / 1000n;
}

export function markDemoClaimed(db: Db, token: Address, now: number): void {
  kvSet(db, `paper.demo_claim.${token}`, { lastClaimAt: now } satisfies ClaimState);
}

// ─── synthetic pool ──────────────────────────────────────────────────────────
interface PoolState {
  ethWei: string;
  tokenRaw: string;
}

/** Uniswap V2-style constant product with a 0.3% fee. */
export function demoPool(db: Db, token: Address): { ethWei: bigint; tokenRaw: bigint } {
  const s = kvGet<PoolState>(db, `paper.demo_pool.${token}`);
  if (s) return { ethWei: BigInt(s.ethWei), tokenRaw: BigInt(s.tokenRaw) };
  const h = seedHash(`pool:${token.toLowerCase()}`);
  return { ethWei: (2n + (h % 6n)) * WEI, tokenRaw: (300_000_000n + (h % 400_000_000n)) * WEI };
}

export function demoQuote(db: Db, token: Address, amountInWei: bigint): bigint {
  const pool = demoPool(db, token);
  const inWithFee = amountInWei * 997n;
  return (pool.tokenRaw * inWithFee) / (pool.ethWei * 1000n + inWithFee);
}

export function applyDemoSwap(db: Db, token: Address, amountInWei: bigint, amountOut: bigint): void {
  const pool = demoPool(db, token);
  kvSet(db, `paper.demo_pool.${token}`, {
    ethWei: (pool.ethWei + amountInWei).toString(),
    tokenRaw: (pool.tokenRaw - amountOut).toString(),
  } satisfies PoolState);
}

/** Spot price of one whole demo token in ETH. */
export function demoPriceEth(db: Db, token: Address): number {
  const pool = demoPool(db, token);
  return Number((pool.ethWei * WEI) / pool.tokenRaw) / 1e18;
}
