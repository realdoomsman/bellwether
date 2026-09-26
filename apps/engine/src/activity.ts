import { txUrl, type ActivityEvent, type ActivityKind, type Address, type ChainKey, type TxRef } from '@floor/shared';
import type { EventBus } from './bus.ts';
import type { Db } from './db.ts';
import type { TxLike } from './ledger.ts';

export const PAPER_PREFIX = 'paper:';

export function toTxRef(tx: TxLike): TxRef {
  return { chain: tx.chain, hash: tx.hash, url: tx.hash.startsWith(PAPER_PREFIX) ? null : txUrl(tx.chain, tx.hash) };
}

export interface NewActivity {
  kind: ActivityKind;
  at: number;
  token: { address: Address; symbol: string } | null;
  title: string;
  amountEth?: number;
  amountUsd?: number;
  tokensBurned?: number;
  market?: string;
  txs?: TxLike[];
}

interface DbActivity {
  id: number;
  kind: string;
  at: number;
  token: string | null;
  token_symbol: string | null;
  title: string;
  amount_eth: number | null;
  amount_usd: number | null;
  tokens_burned: number | null;
  market: string | null;
  txs: string;
}

function fromDb(r: DbActivity): ActivityEvent {
  const ev: ActivityEvent = {
    id: String(r.id),
    kind: r.kind as ActivityKind,
    at: r.at,
    token: r.token as Address | null,
    tokenSymbol: r.token_symbol,
    title: r.title,
    txs: (JSON.parse(r.txs) as { chain: ChainKey; hash: string }[]).map(toTxRef),
  };
  if (r.amount_eth !== null) ev.amountEth = r.amount_eth;
  if (r.amount_usd !== null) ev.amountUsd = r.amount_usd;
  if (r.tokens_burned !== null) ev.tokensBurned = r.tokens_burned;
  if (r.market !== null) ev.market = r.market;
  return ev;
}

/** Inserts an activity row and publishes it on the bus once the surrounding transaction commits. */
export function recordActivity(db: Db, bus: EventBus, a: NewActivity): ActivityEvent {
  const { lastInsertRowid } = db.run(
    `INSERT INTO activity (kind, at, token, token_symbol, title, amount_eth, amount_usd, tokens_burned, market, txs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.kind,
      a.at,
      a.token?.address ?? null,
      a.token?.symbol ?? null,
      a.title,
      a.amountEth ?? null,
      a.amountUsd ?? null,
      a.tokensBurned ?? null,
      a.market ?? null,
      JSON.stringify((a.txs ?? []).map((t) => ({ chain: t.chain, hash: t.hash }))),
    ],
  );
  const event = fromDb(db.get<DbActivity>('SELECT * FROM activity WHERE id = ?', [lastInsertRowid])!);
  db.afterCommit(() => bus.emit({ type: 'activity', data: event }));
  return event;
}

export function listActivity(db: Db, q: { before?: number; limit: number; token?: Address }): ActivityEvent[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.before !== undefined) {
    where.push('id < ?');
    params.push(q.before);
  }
  if (q.token) {
    where.push('token = ?');
    params.push(q.token);
  }
  const sql = `SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return db.all<DbActivity>(sql, [...params, q.limit]).map(fromDb);
}
