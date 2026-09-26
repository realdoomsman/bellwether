import { getAddress, isAddress } from 'viem';
import type { Address, Decision, LaunchpadId, Side, StrategyId, TokenStatus } from '@stepup/shared';
import type { Db } from './db.ts';

export interface TokenRow {
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
  deployer: Address | null;
  totalSupply: bigint | null;
  decimals: number;
  autoDiscovered: boolean;
  demo: boolean;
  rejectedReason: string | null;
  decision: Decision;
  createdAt: number;
  updatedAt: number;
}

interface DbTokenRow {
  address: string;
  name: string;
  symbol: string;
  image: string | null;
  launchpad: string;
  status: string;
  market: string;
  side: string;
  strategy: string;
  max_leverage: number;
  deployer: string | null;
  total_supply: string | null;
  decimals: number;
  auto_discovered: number;
  demo: number;
  rejected_reason: string | null;
  decision: string;
  created_at: number;
  updated_at: number;
}

/** Checksummed address or null when `v` is not an EVM address. */
export function normalizeAddress(v: unknown): Address | null {
  return typeof v === 'string' && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

function fromDb(r: DbTokenRow): TokenRow {
  return {
    address: r.address as Address,
    name: r.name,
    symbol: r.symbol,
    image: r.image,
    launchpad: r.launchpad as LaunchpadId,
    status: r.status as TokenStatus,
    market: r.market,
    side: r.side as Side,
    strategy: r.strategy as StrategyId,
    maxLeverage: r.max_leverage,
    deployer: r.deployer as Address | null,
    totalSupply: r.total_supply === null ? null : BigInt(r.total_supply),
    decimals: r.decimals,
    autoDiscovered: r.auto_discovered === 1,
    demo: r.demo === 1,
    rejectedReason: r.rejected_reason,
    decision: JSON.parse(r.decision) as Decision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getToken(db: Db, address: Address): TokenRow | null {
  const r = db.get<DbTokenRow>('SELECT * FROM tokens WHERE address = ?', [address]);
  return r ? fromDb(r) : null;
}

export function listTokens(db: Db, statuses?: readonly TokenStatus[]): TokenRow[] {
  const rows = statuses
    ? db.all<DbTokenRow>(
        `SELECT * FROM tokens WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC`,
        [...statuses],
      )
    : db.all<DbTokenRow>('SELECT * FROM tokens ORDER BY created_at DESC');
  return rows.map(fromDb);
}

export function insertToken(db: Db, t: TokenRow): void {
  db.run(
    `INSERT INTO tokens (address, name, symbol, image, launchpad, status, market, side, strategy, max_leverage,
       deployer, total_supply, decimals, auto_discovered, demo, rejected_reason, decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.address,
      t.name,
      t.symbol,
      t.image,
      t.launchpad,
      t.status,
      t.market,
      t.side,
      t.strategy,
      t.maxLeverage,
      t.deployer,
      t.totalSupply === null ? null : t.totalSupply.toString(),
      t.decimals,
      t.autoDiscovered ? 1 : 0,
      t.demo ? 1 : 0,
      t.rejectedReason,
      JSON.stringify(t.decision),
      t.createdAt,
      t.updatedAt,
    ],
  );
}

export type TokenPatch = Partial<Pick<TokenRow, 'status' | 'market' | 'side' | 'strategy' | 'maxLeverage' | 'rejectedReason' | 'decision' | 'name' | 'symbol' | 'image'>>;

const COLUMN: Record<keyof TokenPatch, string> = {
  status: 'status',
  market: 'market',
  side: 'side',
  strategy: 'strategy',
  maxLeverage: 'max_leverage',
  rejectedReason: 'rejected_reason',
  decision: 'decision',
  name: 'name',
  symbol: 'symbol',
  image: 'image',
};

export function updateToken(db: Db, address: Address, patch: TokenPatch, at: number): void {
  const keys = (Object.keys(patch) as (keyof TokenPatch)[]).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  const values = keys.map((k) => (k === 'decision' ? JSON.stringify(patch.decision) : (patch[k] as string | number | null)));
  db.run(`UPDATE tokens SET ${keys.map((k) => `${COLUMN[k]} = ?`).join(', ')}, updated_at = ? WHERE address = ?`, [...values, at, address]);
}

export function decision(verdict: Decision['verdict'], message: string, at: number, signal?: { score: number; threshold: number }): Decision {
  return signal ? { verdict, message, at, signalScore: signal.score, signalThreshold: signal.threshold } : { verdict, message, at };
}
