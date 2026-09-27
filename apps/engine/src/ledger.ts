/**
 * Append-only per-token journal. Balances are always derived by SUM over entries.
 * Every operation writes all of its entries in one transaction and is idempotent by
 * (ref_kind, ref_id): replaying the same ref is a no-op that returns null.
 */
import type { Address, ChainKey, StrategyId } from '@bellwether/shared';
import { BRAND, PROFIT_SPLIT, feeSplitFor, splitWei } from '@bellwether/shared';
import type { Db } from './db.ts';
import { allocate, weiToGwei } from './units.ts';

type Unit = 'gwei' | 'micro_usd';

export const ACCOUNTS = {
  /** Cumulative creator fees claimed (monotonic). */
  fees_eth: { unit: 'gwei', label: 'Creator fees claimed', signed: false },
  /** Trading allocation still held as ETH on Robinhood Chain, awaiting the bridge. */
  trading_eth: { unit: 'gwei', label: 'Trading budget awaiting bridge', signed: false },
  /** Free USDC trading budget (Arbitrum + venue margin). */
  trading_usd: { unit: 'micro_usd', label: 'Trading budget (USDC)', signed: false },
  /** Collateral currently in open positions. */
  deployed_usd: { unit: 'micro_usd', label: 'Collateral in open positions', signed: false },
  /** Unspent ETH earmarked to buy back and burn the token itself. */
  token_buyback_eth: { unit: 'gwei', label: 'Token buyback budget', signed: false },
  /** Unspent ETH earmarked to buy back and burn the protocol token. */
  protocol_buyback_eth: { unit: 'gwei', label: `$${BRAND.ticker} buyback budget`, signed: false },
  /** Realized profit earmarked for token buyback, still USDC until crossed into ETH. */
  profit_token_usd: { unit: 'micro_usd', label: 'Profit awaiting token buyback', signed: false },
  /** Realized profit earmarked for the protocol-token buyback, still USDC until crossed into ETH. */
  profit_protocol_usd: { unit: 'micro_usd', label: `Profit awaiting $${BRAND.ticker} buyback`, signed: false },
  /** Cumulative realized PnL net of fees (signed). */
  realized_pnl_usd: { unit: 'micro_usd', label: 'Realized trading PnL', signed: true },
  /** Cumulative ETH spent on buybacks (monotonic). */
  buyback_spent_eth: { unit: 'gwei', label: 'ETH spent on buyback + burn', signed: false },
} as const satisfies Record<string, { unit: Unit; label: string; signed: boolean }>;

export type Account = keyof typeof ACCOUNTS;
export type Book = Record<Account, number>;
export const ACCOUNT_IDS = Object.keys(ACCOUNTS) as Account[];

export interface TxLike {
  chain: ChainKey;
  hash: string;
}

interface Entry {
  token: Address;
  account: Account;
  amount: number;
  positionId?: string;
}

export class LedgerError extends Error {}

export function emptyBook(): Book {
  return Object.fromEntries(ACCOUNT_IDS.map((a) => [a, 0])) as Book;
}

export class Ledger {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  #recorded(kind: string, id: string): boolean {
    return this.db.get('SELECT 1 AS x FROM ledger WHERE ref_kind = ? AND ref_id = ? LIMIT 1', [kind, id]) !== undefined;
  }

  #write(kind: string, id: string, at: number, tx: TxLike | null, entries: Entry[]): void {
    const merged = new Map<string, Entry>();
    for (const e of entries) {
      if (!Number.isSafeInteger(e.amount)) throw new LedgerError(`non-integer amount ${e.amount} for ${e.account}`);
      const key = `${e.token}|${e.account}`;
      const prev = merged.get(key);
      if (prev) prev.amount += e.amount;
      else merged.set(key, { ...e });
    }
    for (const e of merged.values()) {
      if (e.amount === 0) continue;
      this.db.run(
        `INSERT INTO ledger (at, token, account, unit, amount, ref_kind, ref_id, position_id, tx_chain, tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [at, e.token, e.account, ACCOUNTS[e.account].unit, e.amount, kind, id, e.positionId ?? null, tx?.chain ?? null, tx?.hash ?? null],
      );
    }
    for (const e of merged.values()) {
      if (ACCOUNTS[e.account].signed || e.amount >= 0) continue;
      const bal = this.balance(e.token, e.account);
      if (bal < 0) throw new LedgerError(`${e.account} for ${e.token} would go negative (${bal}) in ${kind}:${id}`);
    }
  }

  // Reads come from `balances`, which a trigger keeps equal to SUM(ledger.amount) per (token, account).
  balance(token: Address, account: Account): number {
    return this.db.get<{ amount: number }>('SELECT amount FROM balances WHERE token = ? AND account = ?', [token, account])?.amount ?? 0;
  }

  book(token: Address): Book {
    const book = emptyBook();
    for (const r of this.db.all<{ account: Account; amount: number }>('SELECT account, amount FROM balances WHERE token = ?', [token])) {
      book[r.account] = r.amount;
    }
    return book;
  }

  books(): Map<Address, Book> {
    const out = new Map<Address, Book>();
    for (const r of this.db.all<{ token: Address; account: Account; amount: number }>("SELECT token, account, amount FROM balances WHERE token != ''")) {
      let b = out.get(r.token);
      if (!b) out.set(r.token, (b = emptyBook()));
      b[r.account] = r.amount;
    }
    return out;
  }

  totals(): Book {
    const book = emptyBook();
    for (const r of this.db.all<{ account: Account; s: number }>('SELECT account, sum(amount) AS s FROM balances GROUP BY account')) {
      book[r.account] = r.s;
    }
    return book;
  }

  /** Collateral each token still has deployed in `positionId`. */
  deployedIn(positionId: string): Map<Address, number> {
    const out = new Map<Address, number>();
    for (const r of this.db.all<{ token: Address; s: number }>(
      `SELECT token, sum(amount) AS s FROM ledger WHERE position_id = ? AND account = 'deployed_usd' GROUP BY token`,
      [positionId],
    )) {
      out.set(r.token, r.s);
    }
    return out;
  }

  /** Signed realized PnL (micro-USD) booked at or after `since`, optionally for one token. */
  realizedSince(since: number, token?: Address): number {
    const row = token
      ? this.db.get<{ s: number | null }>(
          `SELECT sum(amount) AS s FROM ledger WHERE account = 'realized_pnl_usd' AND at >= ? AND token = ?`,
          [since, token],
        )
      : this.db.get<{ s: number | null }>(`SELECT sum(amount) AS s FROM ledger WHERE account = 'realized_pnl_usd' AND at >= ?`, [since]);
    return row?.s ?? 0;
  }

  /** Per-UTC-day sums of an account for days starting at or after `since` (read from the daily rollup). */
  daily(account: Account, since: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.db.all<{ day: string; amount: number }>(
      `SELECT day, amount FROM ledger_daily WHERE account = ? AND day >= date(? / 1000, 'unixepoch')`,
      [account, since],
    )) {
      out.set(r.day, r.amount);
    }
    return out;
  }

  /** Creator fees claimed: split immediately per the token's strategy (sub-gwei dust is dropped). */
  recordClaim(p: { token: Address; strategy: StrategyId; amountWei: bigint; tx: TxLike; at: number }) {
    return this.db.transaction(() => {
      if (this.#recorded('claim', p.tx.hash)) return null;
      const gwei = weiToGwei(p.amountWei);
      const split = splitWei(BigInt(gwei), feeSplitFor(p.strategy));
      const result = {
        totalGwei: gwei,
        tradingGwei: Number(split.trading),
        tokenBuybackGwei: Number(split.tokenBuyback),
        protocolBuybackGwei: Number(split.protocolBuyback),
      };
      this.#write('claim', p.tx.hash, p.at, p.tx, [
        { token: p.token, account: 'fees_eth', amount: result.totalGwei },
        { token: p.token, account: 'trading_eth', amount: result.tradingGwei },
        { token: p.token, account: 'token_buyback_eth', amount: result.tokenBuybackGwei },
        { token: p.token, account: 'protocol_buyback_eth', amount: result.protocolBuybackGwei },
      ]);
      return result;
    });
  }

  /** ETH bridged to USDC: the USDC received is credited pro rata to the ETH each token contributed. */
  recordConversion(p: { refId: string; legs: { token: Address; gwei: number }[]; usdcMicro: number; tx: TxLike; at: number }) {
    return this.db.transaction(() => {
      if (this.#recorded('bridge', p.refId)) return null;
      if (p.usdcMicro < 0) throw new LedgerError('negative conversion output');
      const usd = allocate(p.usdcMicro, p.legs.map((l) => l.gwei));
      const legs = p.legs.map((l, i) => ({ token: l.token, gwei: l.gwei, usdMicro: usd[i]! }));
      this.#write(
        'bridge',
        p.refId,
        p.at,
        p.tx,
        legs.flatMap((l) => [
          { token: l.token, account: 'trading_eth' as const, amount: -l.gwei },
          { token: l.token, account: 'trading_usd' as const, amount: l.usdMicro },
        ]),
      );
      return legs;
    });
  }

  /**
   * Internal crossing at `ethUsd`: realized profit (USDC on the venue) earmarked for buybacks is
   * swapped against trading ETH still on Robinhood Chain. Profit-holders get buyback ETH that
   * physically exists on RHC; ETH-holders get the same value as USDC trading budget that
   * physically exists on the venue. Nothing moves on-chain, so the books stay reconcilable.
   */
  crossProfit(p: { refId: string; ethUsd: number; at: number }) {
    return this.db.transaction(() => {
      if (this.#recorded('cross', p.refId)) return null;
      if (!(p.ethUsd > 0)) throw new LedgerError(`invalid ETH price ${p.ethUsd}`);
      const books = this.books();
      const ethSide = [...books].filter(([, b]) => b.trading_eth > 0).map(([token, b]) => ({ token, gwei: b.trading_eth }));
      const profitSide = [...books].flatMap(([token, b]) => [
        ...(b.profit_token_usd > 0 ? [{ token, from: 'profit_token_usd' as const, to: 'token_buyback_eth' as const, micro: b.profit_token_usd }] : []),
        ...(b.profit_protocol_usd > 0 ? [{ token, from: 'profit_protocol_usd' as const, to: 'protocol_buyback_eth' as const, micro: b.profit_protocol_usd }] : []),
      ]);
      const ethTotal = ethSide.reduce((s, l) => s + l.gwei, 0);
      const profitTotal = profitSide.reduce((s, l) => s + l.micro, 0);
      const gwei = Math.min(ethTotal, Math.floor((profitTotal * 1000) / p.ethUsd));
      if (gwei <= 0) return null;
      const micro = Math.min(profitTotal, Math.round((gwei * p.ethUsd) / 1000));
      if (micro <= 0) return null;

      const ethDebits = allocate(gwei, ethSide.map((l) => l.gwei));
      const usdCredits = allocate(micro, ethDebits);
      const profitDebits = allocate(micro, profitSide.map((l) => l.micro));
      const ethCredits = allocate(gwei, profitDebits);
      const entries: Entry[] = [
        ...ethSide.flatMap((l, i) => [
          { token: l.token, account: 'trading_eth' as const, amount: -ethDebits[i]! },
          { token: l.token, account: 'trading_usd' as const, amount: usdCredits[i]! },
        ]),
        ...profitSide.flatMap((l, i) => [
          { token: l.token, account: l.from, amount: -profitDebits[i]! },
          { token: l.token, account: l.to, amount: ethCredits[i]! },
        ]),
      ];
      this.#write('cross', p.refId, p.at, null, entries);
      return { gwei, micro };
    });
  }

  /** Position opened: each leg moves collateral + its fee share out of the free budget. */
  recordOpen(p: {
    positionId: string;
    tradeId: string;
    legs: { token: Address; collateralMicro: number; feeMicro: number }[];
    tx: TxLike;
    at: number;
  }) {
    return this.db.transaction(() => {
      if (this.#recorded('trade', p.tradeId)) return null;
      const entries: Entry[] = [];
      for (const l of p.legs) {
        if (l.collateralMicro <= 0 || l.feeMicro < 0) throw new LedgerError(`invalid open leg for ${l.token}`);
        // A fee above the sizing buffer is paid out of the leg's collateral rather than overdrawing the budget.
        const free = this.balance(l.token, 'trading_usd');
        if (free < l.collateralMicro) throw new LedgerError(`${l.token} budget ${free} < collateral ${l.collateralMicro}`);
        const feeFromBudget = Math.min(l.feeMicro, free - l.collateralMicro);
        const feeFromCollateral = l.feeMicro - feeFromBudget;
        entries.push(
          { token: l.token, account: 'trading_usd', amount: -(l.collateralMicro + feeFromBudget) },
          { token: l.token, account: 'deployed_usd', amount: l.collateralMicro - feeFromCollateral, positionId: p.positionId },
          { token: l.token, account: 'realized_pnl_usd', amount: -l.feeMicro, positionId: p.positionId },
        );
      }
      this.#write('trade', p.tradeId, p.at, p.tx, entries);
      return true;
    });
  }

  /**
   * Reduce or close `fraction` of a pooled position. `pnlMicro` is the net realized PnL of the
   * fill (gross PnL minus fee), attributed by share. A leg's loss comes out of its released
   * collateral; a leg's profit is split PROFIT_SPLIT into buyback earmarks and its collateral
   * returns to the trading budget.
   */
  recordExit(p: {
    positionId: string;
    tradeId: string;
    fraction: number;
    pnlMicro: number;
    shares: { token: Address; share: number }[];
    tx: TxLike | null;
    at: number;
  }) {
    return this.db.transaction(() => {
      if (this.#recorded('trade', p.tradeId)) return null;
      if (!(p.fraction > 0 && p.fraction <= 1)) throw new LedgerError(`invalid exit fraction ${p.fraction}`);
      assertShares(p.shares);
      const deployed = this.deployedIn(p.positionId);
      const pnl = allocate(p.pnlMicro, p.shares.map((s) => s.share * 1e9));
      const protocolBps = BigInt(Math.round(PROFIT_SPLIT.protocolBuyback * 10_000));
      const entries: Entry[] = [];
      const legs = p.shares.map((s, i) => {
        const have = deployed.get(s.token) ?? 0;
        const released = p.fraction === 1 ? have : Math.round(have * p.fraction);
        const legPnl = pnl[i]!;
        entries.push(
          { token: s.token, account: 'deployed_usd', amount: -released, positionId: p.positionId },
          { token: s.token, account: 'realized_pnl_usd', amount: legPnl, positionId: p.positionId },
        );
        if (legPnl >= 0) {
          const protocolPart = Number((BigInt(legPnl) * protocolBps) / 10_000n);
          entries.push(
            { token: s.token, account: 'trading_usd', amount: released },
            { token: s.token, account: 'profit_token_usd', amount: legPnl - protocolPart },
            { token: s.token, account: 'profit_protocol_usd', amount: protocolPart },
          );
        } else {
          entries.push({ token: s.token, account: 'trading_usd', amount: Math.max(0, released + legPnl) });
        }
        return { token: s.token, releasedMicro: released, pnlMicro: legPnl };
      });
      this.#write('trade', p.tradeId, p.at, p.tx, entries);
      return legs;
    });
  }

  /** Buyback executed: spends the named budget of every leg. */
  recordBuyback(p: { refId: string; kind: 'token' | 'protocol'; legs: { token: Address; gwei: number }[]; tx: TxLike; at: number }) {
    return this.db.transaction(() => {
      if (this.#recorded('buyback', p.refId)) return null;
      const budget: Account = p.kind === 'token' ? 'token_buyback_eth' : 'protocol_buyback_eth';
      this.#write(
        'buyback',
        p.refId,
        p.at,
        p.tx,
        p.legs.flatMap((l) => {
          if (l.gwei <= 0) throw new LedgerError(`invalid buyback leg for ${l.token}`);
          return [
            { token: l.token, account: budget, amount: -l.gwei },
            { token: l.token, account: 'buyback_spent_eth' as const, amount: l.gwei },
          ];
        }),
      );
      return true;
    });
  }
}

export function assertShares(shares: readonly { share: number }[]): void {
  const sum = shares.reduce((s, x) => s + x.share, 0);
  if (shares.length === 0 || shares.some((s) => !(s.share > 0)) || Math.abs(sum - 1) > 1e-9) {
    throw new LedgerError(`position shares must be positive and sum to 1 (got ${sum})`);
  }
}
