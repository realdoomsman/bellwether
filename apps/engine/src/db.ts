import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Params = SQLInputValue[] | Record<string, SQLInputValue>;
export type Row = Record<string, SQLInputValue>;

/**
 * Forward-only migrations. Never edit a shipped entry; append a new one.
 * Amounts: ETH as INTEGER gwei, USD as INTEGER micro-USD, raw token units as TEXT.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE tokens (
    address TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    image TEXT,
    launchpad TEXT NOT NULL,
    status TEXT NOT NULL,
    market TEXT NOT NULL,
    side TEXT NOT NULL,
    strategy TEXT NOT NULL,
    max_leverage INTEGER NOT NULL,
    deployer TEXT,
    total_supply TEXT,
    decimals INTEGER NOT NULL,
    auto_discovered INTEGER NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0,
    rejected_reason TEXT,
    decision TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tokens_status ON tokens(status);

  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    token TEXT,
    account TEXT NOT NULL,
    unit TEXT NOT NULL CHECK (unit IN ('gwei', 'micro_usd')),
    amount INTEGER NOT NULL,
    ref_kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    position_id TEXT,
    tx_chain TEXT,
    tx_hash TEXT
  );
  CREATE UNIQUE INDEX ledger_ref ON ledger(ref_kind, ref_id, account, ifnull(token, ''));
  CREATE INDEX ledger_token_account ON ledger(token, account);
  CREATE INDEX ledger_account_at ON ledger(account, at);
  CREATE INDEX ledger_position ON ledger(position_id) WHERE position_id IS NOT NULL;
  CREATE TRIGGER ledger_append_only_update BEFORE UPDATE ON ledger
    BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
  CREATE TRIGGER ledger_append_only_delete BEFORE DELETE ON ledger
    BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

  CREATE TABLE positions (
    id TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    market TEXT NOT NULL,
    side TEXT NOT NULL,
    leverage REAL NOT NULL,
    entry_price REAL NOT NULL,
    size_usd INTEGER NOT NULL,
    collateral_usd INTEGER NOT NULL,
    stage TEXT NOT NULL,
    best_price REAL NOT NULL,
    tp1_hit INTEGER NOT NULL DEFAULT 0,
    tp2_hit INTEGER NOT NULL DEFAULT 0,
    liq_reduced INTEGER NOT NULL DEFAULT 0,
    stop_loss REAL NOT NULL,
    entry_signal REAL,
    mark_price REAL NOT NULL,
    liquidation_price REAL,
    unrealized_pnl_usd INTEGER NOT NULL DEFAULT 0,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    close_reason TEXT
  );
  CREATE UNIQUE INDEX positions_open_market ON positions(market) WHERE closed_at IS NULL;

  CREATE TABLE position_shares (
    position_id TEXT NOT NULL REFERENCES positions(id),
    token TEXT NOT NULL,
    collateral_usd INTEGER NOT NULL,
    share REAL NOT NULL,
    PRIMARY KEY (position_id, token)
  );
  CREATE INDEX position_shares_token ON position_shares(token);

  CREATE TABLE trades (
    id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL REFERENCES positions(id),
    venue TEXT NOT NULL,
    market TEXT NOT NULL,
    side TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    size_usd INTEGER NOT NULL,
    price REAL NOT NULL,
    realized_pnl_usd INTEGER NOT NULL,
    fee_usd INTEGER NOT NULL,
    at INTEGER NOT NULL,
    tx_chain TEXT,
    tx_hash TEXT
  );
  CREATE INDEX trades_at ON trades(at);
  CREATE INDEX trades_position ON trades(position_id);

  CREATE TABLE burns (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    token TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('token', 'floor', 'claim')),
    amount_in_gwei INTEGER NOT NULL,
    amount_out TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    usd_value INTEGER NOT NULL,
    ref_id TEXT NOT NULL,
    swap_chain TEXT,
    swap_hash TEXT,
    burn_chain TEXT NOT NULL,
    burn_hash TEXT NOT NULL
  );
  CREATE INDEX burns_token ON burns(token);
  CREATE INDEX burns_target ON burns(target);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    token TEXT,
    token_symbol TEXT,
    title TEXT NOT NULL,
    amount_eth REAL,
    amount_usd REAL,
    tokens_burned REAL,
    market TEXT,
    txs TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX activity_token ON activity(token, id);

  CREATE TABLE settings_challenges (
    nonce TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE worker_runs (
    id INTEGER PRIMARY KEY,
    worker TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    summary TEXT
  );
  CREATE INDEX worker_runs_worker ON worker_runs(worker, id);

  CREATE TABLE paper_positions (
    symbol TEXT PRIMARY KEY,
    side TEXT NOT NULL,
    size_usd REAL NOT NULL,
    collateral_usd REAL NOT NULL,
    entry_price REAL NOT NULL,
    leverage REAL NOT NULL,
    liquidation_price REAL NOT NULL,
    opened_at INTEGER NOT NULL
  );
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;
  #afterCommit: (() => void)[] = [];

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  }

  #stmt(sql: string): StatementSync {
    let s = this.#statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.#statements.set(sql, s);
    }
    return s;
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const s = this.#stmt(sql);
    const r = Array.isArray(params) ? s.run(...params) : s.run(params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    const s = this.#stmt(sql);
    return (Array.isArray(params) ? s.get(...params) : s.get(params)) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    const s = this.#stmt(sql);
    return (Array.isArray(params) ? s.all(...params) : s.all(params)) as T[];
  }

  migrate(): number {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const current = this.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations')?.v ?? 0;
    if (current > MIGRATIONS.length) {
      throw new Error(`database schema v${current} is newer than this engine (v${MIGRATIONS.length})`);
    }
    for (let v = current + 1; v <= MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.raw.exec(MIGRATIONS[v - 1]!);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [v, Date.now()]);
      });
    }
    return MIGRATIONS.length;
  }

  /** Runs `fn` atomically (BEGIN IMMEDIATE). Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth++;
      try {
        return fn();
      } finally {
        this.#depth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.#depth = 1;
    let committed = false;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      committed = true;
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.#depth = 0;
      const hooks = this.#afterCommit;
      this.#afterCommit = [];
      if (committed) for (const hook of hooks) hook();
    }
  }

  /** Runs `fn` once the current transaction commits (immediately when none is open); dropped on rollback. */
  afterCommit(fn: () => void): void {
    if (this.#depth > 0) this.#afterCommit.push(fn);
    else fn();
  }

  close(): void {
    this.raw.close();
  }
}

export function openDb(file: string): Db {
  const db = new Db(file);
  db.migrate();
  return db;
}

// ─── kv ──────────────────────────────────────────────────────────────────────
export function kvGet<T>(db: Db, key: string): T | null {
  const row = db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
  return row ? (JSON.parse(row.value) as T) : null;
}

export function kvSet(db: Db, key: string, value: unknown): void {
  db.run(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), Date.now()],
  );
}
