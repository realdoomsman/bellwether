/** Pooled positions, their per-token shares, trade fills and burns. */
import type { Address, ChainKey, Side, StrategyId, TradeAction, VenueId } from '@stepup/shared';
import type { Db } from './db.ts';
import type { Stage } from './exits.ts';
import type { TxLike } from './ledger.ts';

export interface PositionRow {
  id: string;
  venue: VenueId;
  market: string;
  side: Side;
  leverage: number;
  entryPrice: number;
  sizeMicro: number;
  collateralMicro: number;
  stage: Stage;
  bestPrice: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  liqReduced: boolean;
  stopLoss: number;
  entrySignal: number | null;
  markPrice: number;
  liquidationPrice: number | null;
  unrealizedPnlMicro: number;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
}

interface DbPosition {
  id: string;
  venue: string;
  market: string;
  side: string;
  leverage: number;
  entry_price: number;
  size_usd: number;
  collateral_usd: number;
  stage: string;
  best_price: number;
  tp1_hit: number;
  tp2_hit: number;
  liq_reduced: number;
  stop_loss: number;
  entry_signal: number | null;
  mark_price: number;
  liquidation_price: number | null;
  unrealized_pnl_usd: number;
  opened_at: number;
  closed_at: number | null;
  close_reason: string | null;
}

function positionFromDb(r: DbPosition): PositionRow {
  return {
    id: r.id,
    venue: r.venue as VenueId,
    market: r.market,
    side: r.side as Side,
    leverage: r.leverage,
    entryPrice: r.entry_price,
    sizeMicro: r.size_usd,
    collateralMicro: r.collateral_usd,
    stage: r.stage as Stage,
    bestPrice: r.best_price,
    tp1Hit: r.tp1_hit === 1,
    tp2Hit: r.tp2_hit === 1,
    liqReduced: r.liq_reduced === 1,
    stopLoss: r.stop_loss,
    entrySignal: r.entry_signal,
    markPrice: r.mark_price,
    liquidationPrice: r.liquidation_price,
    unrealizedPnlMicro: r.unrealized_pnl_usd,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    closeReason: r.close_reason,
  };
}

export function openPositions(db: Db): PositionRow[] {
  return db.all<DbPosition>('SELECT * FROM positions WHERE closed_at IS NULL ORDER BY opened_at').map(positionFromDb);
}

export function getPosition(db: Db, id: string): PositionRow | null {
  const r = db.get<DbPosition>('SELECT * FROM positions WHERE id = ?', [id]);
  return r ? positionFromDb(r) : null;
}

export function insertPosition(db: Db, p: PositionRow): void {
  db.run(
    `INSERT INTO positions (id, venue, market, side, leverage, entry_price, size_usd, collateral_usd, stage, best_price,
       tp1_hit, tp2_hit, liq_reduced, stop_loss, entry_signal, mark_price, liquidation_price, unrealized_pnl_usd, opened_at, closed_at, close_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [
      p.id,
      p.venue,
      p.market,
      p.side,
      p.leverage,
      p.entryPrice,
      p.sizeMicro,
      p.collateralMicro,
      p.stage,
      p.bestPrice,
      p.tp1Hit ? 1 : 0,
      p.tp2Hit ? 1 : 0,
      p.liqReduced ? 1 : 0,
      p.stopLoss,
      p.entrySignal,
      p.markPrice,
      p.liquidationPrice,
      p.unrealizedPnlMicro,
      p.openedAt,
    ],
  );
}

export type PositionPatch = Partial<
  Pick<
    PositionRow,
    | 'sizeMicro'
    | 'collateralMicro'
    | 'stage'
    | 'bestPrice'
    | 'tp1Hit'
    | 'tp2Hit'
    | 'liqReduced'
    | 'markPrice'
    | 'liquidationPrice'
    | 'unrealizedPnlMicro'
    | 'closedAt'
    | 'closeReason'
  >
>;

const POSITION_COLUMN: Record<keyof PositionPatch, string> = {
  sizeMicro: 'size_usd',
  collateralMicro: 'collateral_usd',
  stage: 'stage',
  bestPrice: 'best_price',
  tp1Hit: 'tp1_hit',
  tp2Hit: 'tp2_hit',
  liqReduced: 'liq_reduced',
  markPrice: 'mark_price',
  liquidationPrice: 'liquidation_price',
  unrealizedPnlMicro: 'unrealized_pnl_usd',
  closedAt: 'closed_at',
  closeReason: 'close_reason',
};

export function updatePosition(db: Db, id: string, patch: PositionPatch): void {
  const keys = (Object.keys(patch) as (keyof PositionPatch)[]).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  const values = keys.map((k) => {
    const v = patch[k];
    return typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null);
  });
  db.run(`UPDATE positions SET ${keys.map((k) => `${POSITION_COLUMN[k]} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
}

// ─── shares ──────────────────────────────────────────────────────────────────
export interface ShareRow {
  positionId: string;
  token: Address;
  collateralMicro: number;
  share: number;
}

export function insertShares(db: Db, shares: readonly ShareRow[]): void {
  for (const s of shares) {
    db.run('INSERT INTO position_shares (position_id, token, collateral_usd, share) VALUES (?, ?, ?, ?)', [
      s.positionId,
      s.token,
      s.collateralMicro,
      s.share,
    ]);
  }
}

export function sharesOf(db: Db, positionId: string): ShareRow[] {
  return db
    .all<{ position_id: string; token: string; collateral_usd: number; share: number }>(
      'SELECT * FROM position_shares WHERE position_id = ? ORDER BY share DESC, token',
      [positionId],
    )
    .map((r) => ({ positionId: r.position_id, token: r.token as Address, collateralMicro: r.collateral_usd, share: r.share }));
}

/** Open position a token currently participates in, if any. */
export function openPositionIdFor(db: Db, token: Address): string | null {
  return (
    db.get<{ id: string }>(
      `SELECT p.id FROM positions p JOIN position_shares s ON s.position_id = p.id
       WHERE s.token = ? AND p.closed_at IS NULL LIMIT 1`,
      [token],
    )?.id ?? null
  );
}

// ─── trades ──────────────────────────────────────────────────────────────────
export interface TradeRow {
  id: string;
  positionId: string;
  venue: VenueId;
  market: string;
  side: Side;
  action: TradeAction;
  reason: string;
  sizeMicro: number;
  price: number;
  realizedPnlMicro: number;
  feeMicro: number;
  at: number;
  tx: TxLike | null;
}

interface DbTrade {
  id: string;
  position_id: string;
  venue: string;
  market: string;
  side: string;
  action: string;
  reason: string;
  size_usd: number;
  price: number;
  realized_pnl_usd: number;
  fee_usd: number;
  at: number;
  tx_chain: string | null;
  tx_hash: string | null;
}

function tradeFromDb(r: DbTrade): TradeRow {
  return {
    id: r.id,
    positionId: r.position_id,
    venue: r.venue as VenueId,
    market: r.market,
    side: r.side as Side,
    action: r.action as TradeAction,
    reason: r.reason,
    sizeMicro: r.size_usd,
    price: r.price,
    realizedPnlMicro: r.realized_pnl_usd,
    feeMicro: r.fee_usd,
    at: r.at,
    tx: r.tx_chain && r.tx_hash ? { chain: r.tx_chain as ChainKey, hash: r.tx_hash } : null,
  };
}

export function insertTrade(db: Db, t: TradeRow): void {
  db.run(
    `INSERT INTO trades (id, position_id, venue, market, side, action, reason, size_usd, price, realized_pnl_usd, fee_usd, at, tx_chain, tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.id,
      t.positionId,
      t.venue,
      t.market,
      t.side,
      t.action,
      t.reason,
      t.sizeMicro,
      t.price,
      t.realizedPnlMicro,
      t.feeMicro,
      t.at,
      t.tx?.chain ?? null,
      t.tx?.hash ?? null,
    ],
  );
}

export function listTrades(db: Db, q: { limit: number; token?: Address }): TradeRow[] {
  const rows = q.token
    ? db.all<DbTrade>(
        `SELECT t.* FROM trades t JOIN position_shares s ON s.position_id = t.position_id
         WHERE s.token = ? ORDER BY t.at DESC, t.rowid DESC LIMIT ?`,
        [q.token, q.limit],
      )
    : db.all<DbTrade>('SELECT * FROM trades ORDER BY at DESC, rowid DESC LIMIT ?', [q.limit]);
  return rows.map(tradeFromDb);
}

export interface TradeOutcomes {
  trades: number;
  wins: number;
  losses: number;
  byToken: Map<Address, { trades: number; wins: number }>;
}

/** Closing fills (reduce/close/stop/liquidated) with their outcome, overall and per participating token. */
export function tradeOutcomes(db: Db): TradeOutcomes {
  const totals = db.get<{ n: number; w: number | null; l: number | null }>(
    `SELECT count(*) AS n, sum(realized_pnl_usd > 0) AS w, sum(realized_pnl_usd < 0) AS l FROM trades WHERE action != 'open'`,
  )!;
  const byToken = new Map<Address, { trades: number; wins: number }>();
  for (const r of db.all<{ token: string; n: number; w: number }>(
    `SELECT s.token AS token, count(*) AS n, sum(t.realized_pnl_usd > 0) AS w
     FROM trades t JOIN position_shares s ON s.position_id = t.position_id
     WHERE t.action != 'open' GROUP BY s.token`,
  )) {
    byToken.set(r.token as Address, { trades: r.n, wins: r.w });
  }
  return { trades: totals.n, wins: totals.w ?? 0, losses: totals.l ?? 0, byToken };
}

// ─── burns ───────────────────────────────────────────────────────────────────
export interface BurnRow {
  at: number;
  /** Token whose budget paid (or whose claim produced the tokens). */
  token: Address;
  /** Token that was burned. */
  target: Address;
  kind: 'token' | 'protocol' | 'claim';
  amountInGwei: number;
  amountOut: bigint;
  decimals: number;
  usdMicro: number;
  refId: string;
  swapTx: TxLike | null;
  burnTx: TxLike;
}

/** Records a burn and folds it into `burn_totals` atomically (raw amounts exceed int64, so the sum is kept in JS). */
export function insertBurn(db: Db, b: BurnRow): void {
  db.transaction(() => {
    const newBuyback = b.kind !== 'claim' && !db.get('SELECT 1 FROM burns WHERE ref_id = ? AND kind != ? LIMIT 1', [b.refId, 'claim']);
    db.run(
      `INSERT INTO burns (at, token, target, kind, amount_in_gwei, amount_out, decimals, usd_value, ref_id, swap_chain, swap_hash, burn_chain, burn_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.at,
        b.token,
        b.target,
        b.kind,
        b.amountInGwei,
        b.amountOut.toString(),
        b.decimals,
        b.usdMicro,
        b.refId,
        b.swapTx?.chain ?? null,
        b.swapTx?.hash ?? null,
        b.burnTx.chain,
        b.burnTx.hash,
      ],
    );
    const prev = db.get<{ amount_out: string }>('SELECT amount_out FROM burn_totals WHERE target = ?', [b.target]);
    db.run(
      `INSERT INTO burn_totals (target, amount_out, usd_value, buybacks) VALUES (?, ?, ?, ?)
       ON CONFLICT (target) DO UPDATE SET amount_out = excluded.amount_out, usd_value = usd_value + excluded.usd_value,
         buybacks = buybacks + excluded.buybacks`,
      [b.target, ((prev ? BigInt(prev.amount_out) : 0n) + b.amountOut).toString(), b.usdMicro, newBuyback ? 1 : 0],
    );
  });
}

export interface BurnTotals {
  /** Raw units burned per burned token. */
  byTarget: Map<Address, bigint>;
  usdMicro: number;
  /** Distinct buyback swaps (claim-time burns excluded). */
  buybacks: number;
}

export function burnTotals(db: Db): BurnTotals {
  const byTarget = new Map<Address, bigint>();
  let usdMicro = 0;
  let buybacks = 0;
  for (const r of db.all<{ target: string; amount_out: string; usd_value: number; buybacks: number }>('SELECT * FROM burn_totals')) {
    byTarget.set(r.target as Address, BigInt(r.amount_out));
    usdMicro += r.usd_value;
    buybacks += r.buybacks;
  }
  return { byTarget, usdMicro, buybacks };
}

/** Current strategies of every token sharing a position. */
export function participantStrategies(db: Db, positionId: string): StrategyId[] {
  return db
    .all<{ strategy: string }>(
      'SELECT t.strategy AS strategy FROM position_shares s JOIN tokens t ON t.address = s.token WHERE s.position_id = ?',
      [positionId],
    )
    .map((r) => r.strategy as StrategyId);
}
