import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, pad, toEventSelector, zeroAddress } from 'viem';
import type { Address, Log, TransactionReceipt } from 'viem';
import { loadConfig } from '../config.ts';
import type { Client } from './chains.ts';
import { PriceGuardError } from './errors.ts';
import type { SendRequest, TxSender } from './tx.ts';
import {
  OBSERVATION_CARDINALITY,
  createUniswap,
  meanTick,
  minAmountOut,
  priceImpactBps,
  referenceAmount,
  tokensPerWethAtTick,
  twapDeviationBps,
} from './uniswap.ts';

test('minimum output applies the slippage budget and rounds down', () => {
  assert.equal(minAmountOut(10_000n, 150), 9_850n);
  assert.equal(minAmountOut(999n, 1), 998n); // 998.9 → 998: never above the budget
  assert.equal(minAmountOut(10n ** 18n, 0), 10n ** 18n);
  assert.equal(minAmountOut(10n ** 18n, 50), 995n * 10n ** 15n);
});

test('slippage outside [0, 10000) or fractional is rejected', () => {
  assert.throws(() => minAmountOut(1n, 10_000), RangeError);
  assert.throws(() => minAmountOut(1n, -1), RangeError);
  assert.throws(() => minAmountOut(1n, 1.5), RangeError);
});

test('mean tick rounds toward negative infinity like OracleLibrary', () => {
  assert.equal(meanTick(0n, 900n * 200n, 900), 200);
  assert.equal(meanTick(0n, 901n, 900), 1);
  assert.equal(meanTick(0n, -901n, 900), -2); // -1.001 → -2, not -1
  assert.equal(meanTick(0n, -900n, 900), -1);
  assert.equal(meanTick(1_168_194_760_688n, 1_168_375_054_088n, 900), 200_326); // $FILL pool, real observe()
});

test('tokens per WETH follows token ordering in the pool', () => {
  // token1 = token: the pool price (token1 per token0) is tokens per WETH.
  assert.ok(Math.abs(tokensPerWethAtTick(69_078, false) / 1000 - 1) < 1e-3);
  // token0 = token: the pool price is WETH per token, so invert.
  assert.ok(Math.abs(tokensPerWethAtTick(69_078, true) / 0.001 - 1) < 1e-3);
  assert.equal(tokensPerWethAtTick(0, true), 1);
});

test('TWAP deviation nets out the LP fee and is negative when buying below fair', () => {
  // Fair 1000 per wei, 1% fee → 990 per wei is exactly fair.
  assert.ok(Math.abs(twapDeviationBps(10n ** 18n, 990n * 10n ** 18n, 1000, 10_000)) < 1e-6);
  assert.ok(Math.abs(twapDeviationBps(10n ** 18n, 940_500n * 10n ** 15n, 1000, 10_000) - 500) < 1e-6);
  assert.ok(twapDeviationBps(10n ** 18n, 995n * 10n ** 18n, 1000, 10_000) < 0);
});

test('price impact compares against a small reference trade', () => {
  const ref = { amountIn: 10n ** 15n, amountOut: 10n ** 18n }; // 1000 per wei
  assert.equal(priceImpactBps(ref, { amountIn: 10n ** 18n, amountOut: 10n ** 21n }), 0);
  assert.ok(Math.abs(priceImpactBps(ref, { amountIn: 10n ** 18n, amountOut: 8n * 10n ** 20n }) - 2000) < 1e-9);
  assert.equal(priceImpactBps({ amountIn: 1n, amountOut: 0n }, { amountIn: 10n, amountOut: 10n }), Infinity);
});

test('reference amount is 1/1000 of the trade, floored to a minimum, never above the trade', () => {
  assert.equal(referenceAmount(10n ** 18n), 10n ** 15n);
  assert.equal(referenceAmount(10n ** 14n), 10n ** 12n);
  assert.equal(referenceAmount(5n), 5n);
});

// ─── buyAndBurn against a stubbed chain ──────────────────────────────────────

const net = { ...loadConfig({ ENGINE_MODE: 'paper' }).network, protocolAddress: '0x00000000000000000000000000000000000000a1' as Address };
const TOKEN: Address = '0x7f0404070cf6FB703af9f3B89f84Af3FFE2A54B3'; // above WETH: token1 in its pool
const POOL: Address = '0x00000000000000000000000000000000000000b2';
const TICK = 69_078; // ≈ 1000 tokens per wei
const limits = { maxTwapDeviationBps: 300, maxPriceImpactBps: 500 };

interface Chain {
  /** Tokens per wei quoted for a trade of `amountIn` on the 1% tier (the only tier with liquidity). */
  rate?: (amountIn: bigint) => bigint;
  cardinalityNext?: number;
  /** Protocol wallet balance at the swap's block; throw to simulate a failing historical read. */
  balanceAfter?: () => bigint;
}

function stubRhc({ rate = () => 1000n, cardinalityNext = OBSERVATION_CARDINALITY, balanceAfter = () => 7n }: Chain): Client {
  const stub = {
    async readContract(p: { functionName: string; blockNumber?: bigint }) {
      switch (p.functionName) {
        case 'getLaunchedToken':
          return { exists: false, token: zeroAddress };
        case 'factory':
          return '0x00000000000000000000000000000000000000f1';
        case 'getPool':
          return POOL;
        case 'slot0':
          return [0n, TICK, 0, 1, cardinalityNext, 0, true];
        case 'observe':
          return [[0n, BigInt(TICK * 900)], [0n, 0n]];
        case 'balanceOf':
          return p.blockNumber === undefined ? 0n : balanceAfter();
      }
      throw new Error(`unexpected read ${p.functionName}`);
    },
    async simulateContract(p: { args: [{ amountIn: bigint; fee: number }] }) {
      const { amountIn, fee } = p.args[0];
      if (fee !== 10_000) throw new Error('no pool');
      return { result: [amountIn * rate(amountIn), 0n, 0, 0n] };
    },
  };
  // Test double: implements only the client methods the V3 path calls.
  const client = stub as unknown as Client;
  return client;
}

const transferToWallet: Log = {
  address: TOKEN,
  topics: [toEventSelector('Transfer(address,address,uint256)'), pad(POOL), pad(net.protocolAddress)],
  data: encodeAbiParameters([{ type: 'uint256' }], [42n]),
  blockHash: null,
  blockNumber: null,
  logIndex: null,
  transactionHash: null,
  transactionIndex: null,
  removed: false,
};

function stubSender(failing: RegExp | null) {
  const sent: string[] = [];
  const sender: TxSender = {
    address: net.protocolAddress,
    exclusive: (fn) =>
      fn(async (req: SendRequest) => {
        sent.push(req.what);
        if (failing?.test(req.what)) throw new Error(`${req.what}: send failed: nope`);
        // Test double: the fields buyAndBurn reads from a receipt.
        const receipt = { blockNumber: 9n, logs: [transferToWallet] } as unknown as TransactionReceipt;
        return { ref: { chain: 'rhc', hash: `0x${sent.length}` }, receipt, gasCostWei: 0n };
      }),
  };
  return { sender, sent };
}

test('buyback grows TWAP history once, swaps, then burns the balance delta', async () => {
  const { sender, sent } = stubSender(null);
  const dex = createUniswap({ rhc: stubRhc({ cardinalityNext: 1 }), net, sender, limits });
  const res = await dex.buyAndBurn(TOKEN, 10n ** 18n, 150);
  assert.deepEqual(sent, [`grow TWAP history of the ${TOKEN} pool`, `Uniswap V3 buyback of ${TOKEN}`, `burn 7 of ${TOKEN}`]);
  assert.equal(res.amountOut, 7n);
  assert.deepEqual(res.burnTx, { chain: 'rhc', hash: '0x3' });
});

test('a failed burn after the swap returns burnTx null instead of throwing', async () => {
  const { sender, sent } = stubSender(/^burn /);
  const dex = createUniswap({ rhc: stubRhc({}), net, sender, limits });
  const res = await dex.buyAndBurn(TOKEN, 10n ** 18n, 150);
  assert.equal(sent.length, 2);
  assert.deepEqual(res.swapTx, { chain: 'rhc', hash: '0x1' });
  assert.equal(res.amountOut, 7n);
  assert.equal(res.burnTx, null);
});

test('a failed post-swap balance read falls back to the receipt Transfers', async () => {
  const { sender } = stubSender(null);
  const rhc = stubRhc({
    balanceAfter: () => {
      throw new Error('missing trie node');
    },
  });
  const res = await createUniswap({ rhc, net, sender, limits }).buyAndBurn(TOKEN, 10n ** 18n, 150);
  assert.equal(res.amountOut, 42n);
  assert.notEqual(res.burnTx, null);
});

test('price guards refuse before sending anything', async () => {
  const cases: [Chain, string][] = [
    [{ rate: () => 900n }, 'twap-deviation'], // ~9% below the 1000/wei TWAP after the 1% fee
    [{ rate: (a) => (a >= 10n ** 18n ? 800n : 1000n) }, 'price-impact'], // 20% worse than the reference trade
  ];
  for (const [chain, kind] of cases) {
    const { sender, sent } = stubSender(null);
    const dex = createUniswap({ rhc: stubRhc(chain), net, sender, limits });
    await assert.rejects(dex.buyAndBurn(TOKEN, 10n ** 18n, 150), (err: unknown) => err instanceof PriceGuardError && err.kind === kind);
    assert.deepEqual(sent, []);
  }
});

test('burnHeld refuses more than the wallet holds', async () => {
  const { sender, sent } = stubSender(null);
  const dex = createUniswap({ rhc: stubRhc({}), net, sender, limits });
  await assert.rejects(dex.burnHeld(TOKEN, 1n), /holds only 0/);
  assert.deepEqual(sent, []);
});
