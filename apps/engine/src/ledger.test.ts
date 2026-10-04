import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from './db.ts';
import { Ledger, LedgerError } from './ledger.ts';
import { address } from './testing/fakes.ts';

const A = address(0xa);
const B = address(0xb);
const GWEI = 10n ** 9n;
const ETH = 10n ** 18n;
const rhc = (hash: string) => ({ chain: 'rhc' as const, hash });
const hl = (hash: string) => ({ chain: 'hyperliquid' as const, hash });

function setup() {
  const db = openDb(':memory:');
  return { db, ledger: new Ledger(db) };
}

function rowCount(db: ReturnType<typeof setup>['db']): number {
  return db.get<{ n: number }>('SELECT count(*) AS n FROM ledger')!.n;
}

test('claim splits 60/25/15 exactly in gwei with rounding dust to the token buyback', () => {
  const { ledger } = setup();
  const r = ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: 1_000_000_007n * GWEI + 123n, tx: rhc('0x1'), at: 1 });
  assert.deepEqual(r, { totalGwei: 1_000_000_007, tradingGwei: 600_000_004, tokenBuybackGwei: 250_000_002, protocolBuybackGwei: 150_000_001 });
  const book = ledger.book(A);
  assert.equal(book.fees_eth, 1_000_000_007);
  assert.equal(book.trading_eth + book.token_buyback_eth + book.protocol_buyback_eth, book.fees_eth);
});

test('burn-only strategy routes nothing to trading', () => {
  const { ledger } = setup();
  const r = ledger.recordClaim({ token: A, strategy: 'burn', amountWei: 1_000_000_007n * GWEI, tx: rhc('0x1'), at: 1 });
  assert.deepEqual(r, { totalGwei: 1_000_000_007, tradingGwei: 0, tokenBuybackGwei: 850_000_006, protocolBuybackGwei: 150_000_001 });
  assert.equal(ledger.book(A).trading_eth, 0);
});

test('replaying a ref is a no-op', () => {
  const { db, ledger } = setup();
  ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, tx: rhc('0x1'), at: 1 });
  const before = rowCount(db);
  assert.equal(ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, tx: rhc('0x1'), at: 2 }), null);
  assert.equal(rowCount(db), before);
  assert.equal(ledger.book(A).fees_eth, 1_000_000_000);
});

test('an operation that would overdraw an account throws and writes nothing', () => {
  const { db, ledger } = setup();
  ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, tx: rhc('0x1'), at: 1 });
  const before = rowCount(db);
  assert.throws(
    () => ledger.recordBuyback({ refId: 'b1', kind: 'token', legs: [{ token: A, gwei: 250_000_001 }], tx: rhc('0x2'), at: 2 }),
    LedgerError,
  );
  assert.equal(rowCount(db), before);
  assert.equal(ledger.book(A).token_buyback_eth, 250_000_000);
});

test('the journal is append-only', () => {
  const { db, ledger } = setup();
  ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, tx: rhc('0x1'), at: 1 });
  assert.throws(() => db.run('UPDATE ledger SET amount = 0'), /append-only/);
  assert.throws(() => db.run('DELETE FROM ledger'), /append-only/);
});

/** A: 1 ETH and B: 0.5 ETH of balanced fees, bridged to 3000.000001 USDC. */
function fundedTwoTokens() {
  const s = setup();
  s.ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, tx: rhc('0xa1'), at: 1 });
  s.ledger.recordClaim({ token: B, strategy: 'balanced', amountWei: ETH / 2n, tx: rhc('0xb1'), at: 1 });
  s.ledger.recordConversion({
    refId: 'bridge-1',
    legs: [
      { token: A, gwei: 600_000_000 },
      { token: B, gwei: 300_000_000 },
    ],
    usdcMicro: 3_000_000_001,
    tx: rhc('0xbr'),
    at: 2,
  });
  return s;
}

test('conversion credits USDC pro rata to the ETH each token contributed, exactly', () => {
  const { ledger } = fundedTwoTokens();
  assert.equal(ledger.book(A).trading_eth, 0);
  assert.equal(ledger.book(B).trading_eth, 0);
  assert.equal(ledger.book(A).trading_usd, 2_000_000_001);
  assert.equal(ledger.book(B).trading_usd, 1_000_000_000);
});

test('profitable close returns collateral to the budget and routes profit 80/20 to buyback earmarks', () => {
  const { ledger } = fundedTwoTokens();
  ledger.recordOpen({
    positionId: 'p1',
    tradeId: 't-open',
    legs: [
      { token: A, collateralMicro: 300_000_000, feeMicro: 300_000 },
      { token: B, collateralMicro: 100_000_000, feeMicro: 100_000 },
    ],
    tx: hl('0xo'),
    at: 3,
  });
  assert.equal(ledger.book(A).trading_usd, 2_000_000_001 - 300_300_000);
  assert.equal(ledger.book(A).deployed_usd, 300_000_000);
  assert.equal(ledger.book(B).realized_pnl_usd, -100_000);

  const legs = ledger.recordExit({
    positionId: 'p1',
    tradeId: 't-close',
    fraction: 1,
    pnlMicro: 40_000_000,
    shares: [
      { token: A, share: 0.75 },
      { token: B, share: 0.25 },
    ],
    tx: hl('0xc'),
    at: 4,
  });
  assert.deepEqual(legs, [
    { token: A, releasedMicro: 300_000_000, pnlMicro: 30_000_000 },
    { token: B, releasedMicro: 100_000_000, pnlMicro: 10_000_000 },
  ]);
  const a = ledger.book(A);
  assert.equal(a.deployed_usd, 0);
  assert.equal(a.trading_usd, 2_000_000_001 - 300_000);
  assert.equal(a.realized_pnl_usd, 30_000_000 - 300_000);
  assert.equal(a.profit_token_usd, 24_000_000);
  assert.equal(a.profit_protocol_usd, 6_000_000);
  assert.equal(ledger.book(B).profit_token_usd, 8_000_000);
  assert.equal(ledger.book(B).profit_protocol_usd, 2_000_000);
});

test('losing reduce releases collateral net of the loss and earmarks nothing', () => {
  const { ledger } = fundedTwoTokens();
  ledger.recordOpen({
    positionId: 'p2',
    tradeId: 'o2',
    legs: [
      { token: A, collateralMicro: 100_000_000, feeMicro: 0 },
      { token: B, collateralMicro: 100_000_000, feeMicro: 0 },
    ],
    tx: hl('0xo2'),
    at: 3,
  });
  const shares = [
    { token: A, share: 0.5 },
    { token: B, share: 0.5 },
  ];
  ledger.recordExit({ positionId: 'p2', tradeId: 'r2', fraction: 0.5, pnlMicro: -30_000_000, shares, tx: hl('0xr2'), at: 4 });
  const a = ledger.book(A);
  assert.equal(a.deployed_usd, 50_000_000);
  assert.equal(a.trading_usd, 2_000_000_001 - 100_000_000 + 35_000_000);
  assert.equal(a.realized_pnl_usd, -15_000_000);
  assert.equal(a.profit_token_usd + a.profit_protocol_usd, 0);
  assert.deepEqual([...ledger.deployedIn('p2').values()], [50_000_000, 50_000_000]);
  assert.equal(ledger.recordExit({ positionId: 'p2', tradeId: 'r2', fraction: 0.5, pnlMicro: -30_000_000, shares, tx: null, at: 5 }), null);
});

test('exit shares must be positive and sum to 1', () => {
  const { ledger } = fundedTwoTokens();
  assert.throws(
    () =>
      ledger.recordExit({
        positionId: 'p',
        tradeId: 'x',
        fraction: 1,
        pnlMicro: 0,
        shares: [
          { token: A, share: 0.6 },
          { token: B, share: 0.6 },
        ],
        tx: null,
        at: 1,
      }),
    LedgerError,
  );
});

test('profit crossing swaps USD earmarks for trading ETH at one price, conserving value', () => {
  const { ledger } = fundedTwoTokens();
  ledger.recordOpen({ positionId: 'p', tradeId: 'o', legs: [{ token: A, collateralMicro: 100_000_000, feeMicro: 0 }], tx: hl('0xo'), at: 3 });
  ledger.recordExit({ positionId: 'p', tradeId: 'c', fraction: 1, pnlMicro: 30_000_000, shares: [{ token: A, share: 1 }], tx: hl('0xc'), at: 4 });
  ledger.recordClaim({ token: B, strategy: 'balanced', amountWei: ETH, tx: rhc('0xb2'), at: 5 });

  const crossed = ledger.crossProfit({ refId: 'x1', ethUsd: 3000, at: 6 });
  assert.deepEqual(crossed, { gwei: 10_000_000, micro: 30_000_000 });
  const a = ledger.book(A);
  const b = ledger.book(B);
  assert.equal(a.profit_token_usd + a.profit_protocol_usd, 0);
  assert.equal(a.token_buyback_eth, 250_000_000 + 8_000_000);
  assert.equal(a.protocol_buyback_eth, 150_000_000 + 2_000_000);
  assert.equal(b.trading_eth, 600_000_000 - 10_000_000);
  assert.equal(b.trading_usd, 1_000_000_000 + 30_000_000);
  assert.equal(ledger.crossProfit({ refId: 'x2', ethUsd: 3000, at: 7 }), null);
});

test('rollups always equal the journal sums, including after a rejected operation', () => {
  const { db, ledger } = fundedTwoTokens();
  ledger.recordOpen({ positionId: 'p', tradeId: 'o', legs: [{ token: A, collateralMicro: 100_000_000, feeMicro: 0 }], tx: hl('0xo'), at: 3 });
  ledger.recordExit({ positionId: 'p', tradeId: 'c', fraction: 1, pnlMicro: -40_000_000, shares: [{ token: A, share: 1 }], tx: hl('0xc'), at: 4 });
  assert.throws(() => ledger.recordBuyback({ refId: 'over', kind: 'token', legs: [{ token: B, gwei: 999_999_999_999 }], tx: rhc('0xz'), at: 5 }), LedgerError);
  const journal = db.all<{ token: string; account: string; s: number }>(
    "SELECT ifnull(token, '') AS token, account, sum(amount) AS s FROM ledger GROUP BY 1, 2 ORDER BY 1, 2",
  );
  const balances = db.all<{ token: string; account: string; s: number }>('SELECT token, account, amount AS s FROM balances ORDER BY 1, 2');
  assert.deepEqual(balances, journal);
  const daily = db.all<{ day: string; account: string; s: number }>(
    "SELECT date(at / 1000, 'unixepoch') AS day, account, sum(amount) AS s FROM ledger GROUP BY 1, 2 ORDER BY 1, 2",
  );
  assert.deepEqual(db.all('SELECT day, account, amount AS s FROM ledger_daily ORDER BY 1, 2'), daily);
  assert.throws(() => db.run('DELETE FROM balances'), /derived from the ledger/);
});

test('claim gas is paid out of the claim before the split; fees stay gross', () => {
  const { ledger } = setup();
  const r = ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: ETH, gasWei: 10_000n * GWEI - 1n, tx: rhc('0x1'), at: 1 });
  assert.deepEqual(r, { totalGwei: 1_000_000_000, tradingGwei: 599_994_000, tokenBuybackGwei: 249_997_500, protocolBuybackGwei: 149_998_500 });
  const book = ledger.book(A);
  assert.equal(book.fees_eth, 1_000_000_000);
  assert.equal(book.gas_eth, 10_000, 'sub-gwei gas rounds up');
  assert.equal(book.trading_eth + book.token_buyback_eth + book.protocol_buyback_eth + book.gas_eth, book.fees_eth);
});

test('gas is charged to the preferred budget, then the token\'s other ETH budgets, and the rest becomes debt', () => {
  const { ledger } = setup();
  ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: 1_000n * GWEI, tx: rhc('0x1'), at: 1 }); // 600 / 250 / 150
  assert.deepEqual(ledger.recordGas({ refId: '0xg1', legs: [{ token: A, gwei: 1 }], gasWei: 300n * GWEI, prefer: 'token_buyback_eth', tx: rhc('0xg1'), at: 2 }), { gwei: 300, debtGwei: 0 });
  let book = ledger.book(A);
  assert.deepEqual([book.token_buyback_eth, book.trading_eth, book.protocol_buyback_eth], [0, 550, 150]);
  assert.deepEqual(ledger.recordGas({ refId: '0xg2', legs: [{ token: A, gwei: 1 }], gasWei: 1_000n * GWEI, prefer: 'trading_eth', tx: rhc('0xg2'), at: 3 }), { gwei: 1_000, debtGwei: 300 });
  book = ledger.book(A);
  assert.deepEqual([book.token_buyback_eth, book.trading_eth, book.protocol_buyback_eth, book.gas_eth, book.gas_debt_eth], [0, 0, 0, 1_300, 300]);
  assert.equal(ledger.recordGas({ refId: '0xg2', legs: [{ token: A, gwei: 1 }], gasWei: 1_000n * GWEI, prefer: 'trading_eth', tx: rhc('0xg2'), at: 4 }), null, 'idempotent by hash');
  assert.equal(ledger.recordGas({ refId: '0xg3', legs: [{ token: A, gwei: 1 }], gasWei: 0n, prefer: 'trading_eth', tx: null, at: 4 }), null, 'zero gas books nothing');

  // The next claim repays the debt first.
  ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: 1_000n * GWEI, tx: rhc('0x2'), at: 5 });
  book = ledger.book(A);
  assert.equal(book.gas_debt_eth, 0);
  assert.equal(book.trading_eth + book.token_buyback_eth + book.protocol_buyback_eth, 700);
});

test('gas of a shared tx is split across its tokens pro rata, each paying from its own budgets', () => {
  const { ledger } = setup();
  ledger.recordClaim({ token: A, strategy: 'balanced', amountWei: 1_000n * GWEI, tx: rhc('0x1'), at: 1 });
  ledger.recordClaim({ token: B, strategy: 'balanced', amountWei: 1_000n * GWEI, tx: rhc('0x2'), at: 1 });
  ledger.recordGas({ refId: '0xg', legs: [{ token: A, gwei: 300 }, { token: B, gwei: 100 }], gasWei: 40n * GWEI, prefer: 'protocol_buyback_eth', tx: rhc('0xg'), at: 2 });
  assert.equal(ledger.book(A).gas_eth, 30);
  assert.equal(ledger.book(A).protocol_buyback_eth, 120);
  assert.equal(ledger.book(B).gas_eth, 10);
  assert.equal(ledger.book(B).protocol_buyback_eth, 140);
});
