import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, pad, parseAbi, toEventSelector, TransactionReceiptNotFoundError, zeroAddress } from 'viem';
import type { Address, Hex, Log, TransactionReceipt } from 'viem';
import { BURN_ADDRESS } from '@bellwether/shared';
import { loadConfig } from '../config.ts';
import type { BroadcastTx } from '../ports.ts';
import type { Client } from './chains.ts';
import { PriceGuardError } from './errors.ts';
import { UnconfirmedTxError } from './tx.ts';
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
const BLOCK_TIME = 1_000n;
const GAS = 5n;
const limits = { maxTwapDeviationBps: 300, maxPriceImpactBps: 500 };
const MULTICALL_ABI = parseAbi(['function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)']);

interface Chain {
  /** Tokens per wei quoted for a trade of `amountIn` (V3: on the 1% tier, the only one with liquidity). */
  rate?: (amountIn: bigint) => bigint;
  cardinalityNext?: number;
  /** Protocol wallet balance at the swap's block; throw to simulate a failing historical read. */
  balanceAfter?: () => bigint;
  /** Protocol wallet balance at the latest block, by read number (read 0 is the pre-swap balance); throw to fail it. */
  balanceLatest?: (read: number) => bigint;
  /** The token is a graduated Pons V2 launch trading in its native-ETH V4 pool. */
  v4?: boolean;
}

function stubRhc({ rate = () => 1000n, cardinalityNext = OBSERVATION_CARDINALITY, balanceAfter = () => 7n, balanceLatest = () => 0n, v4 = false }: Chain): Client {
  let latestReads = 0;
  const stub = {
    async readContract(p: { functionName: string; blockNumber?: bigint }) {
      switch (p.functionName) {
        case 'getLaunchedToken':
          return v4
            ? { token: TOKEN, curve: POOL, deployer: zeroAddress, creatorFeeRecipient: zeroAddress, pairToken: zeroAddress, poolFee: 0, tickSpacing: 60, buybackEnabled: false, phase: 2, exists: true }
            : { exists: false, token: zeroAddress };
        case 'factory':
          return '0x00000000000000000000000000000000000000f1';
        case 'getPool':
          return POOL;
        case 'slot0':
          return [0n, TICK, 0, 1, cardinalityNext, 0, true];
        case 'observe':
          return [[0n, BigInt(TICK * 900)], [0n, 0n]];
        case 'balanceOf':
          return p.blockNumber === undefined ? balanceLatest(latestReads++) : balanceAfter();
      }
      throw new Error(`unexpected read ${p.functionName}`);
    },
    async simulateContract(p: { args: [{ amountIn?: bigint; fee?: number; exactAmount?: bigint }] }) {
      const { amountIn, fee, exactAmount } = p.args[0];
      if (exactAmount !== undefined) return { result: [exactAmount * rate(exactAmount), 0n] }; // V4 quoter
      if (fee !== 10_000) throw new Error('no pool');
      return { result: [amountIn! * rate(amountIn!), 0n, 0, 0n] };
    },
    async getBlock() {
      return { timestamp: BLOCK_TIME };
    },
  };
  // Test double: implements only the client methods the buyback paths call.
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

/** Every tx mines and costs GAS, except those matching `failing` (send fails) or `unconfirmed` (broadcast, no receipt). */
function stubSender(failing: RegExp | null, unconfirmed: RegExp | null = null) {
  const sent: string[] = [];
  const requests: SendRequest[] = [];
  const sender: TxSender = {
    address: net.protocolAddress,
    exclusive: (fn) =>
      fn(async (req: SendRequest) => {
        sent.push(req.what);
        requests.push(req);
        if (failing?.test(req.what)) throw new Error(`${req.what}: send failed: nope`);
        const hash: Hex = `0x${sent.length}`;
        req.onBroadcast?.(hash, sent.length);
        if (unconfirmed?.test(req.what)) throw new UnconfirmedTxError(`${req.what}: no receipt for ${hash}`, hash, sent.length);
        // Test double: the fields buyAndBurn reads from a receipt.
        const receipt = { blockNumber: 9n, logs: [transferToWallet] } as unknown as TransactionReceipt;
        return { ref: { chain: 'rhc', hash }, receipt, gasCostWei: GAS };
      }),
    lookup: async () => null,
    minedNonce: async () => 0,
  };
  return { sender, sent, requests };
}

test('buyback grows TWAP history once, swaps, then burns the balance delta, reporting all their gas', async () => {
  const { sender, sent } = stubSender(null);
  const dex = createUniswap({ rhc: stubRhc({ cardinalityNext: 1 }), net, sender, limits });
  const res = await dex.buyAndBurn(TOKEN, 10n ** 18n, 150);
  assert.deepEqual(sent, [`grow TWAP history of the ${TOKEN} pool`, `Uniswap V3 buyback of ${TOKEN}`, `burn 7 of ${TOKEN}`]);
  assert.equal(res.amountOut, 7n);
  assert.deepEqual(res.burnTx, { chain: 'rhc', hash: '0x3' });
  assert.equal(res.gasWei, 3n * GAS);
});

test('the V3 swap goes through a multicall that expires shortly after it was built', async () => {
  const { sender, requests } = stubSender(null);
  await createUniswap({ rhc: stubRhc({}), net, sender, limits }).buyAndBurn(TOKEN, 10n ** 18n, 150);
  const swap = requests.find((r) => r.what.startsWith('Uniswap V3'))!;
  const call = decodeFunctionData({ abi: MULTICALL_ABI, data: swap.data! });
  assert.equal(call.functionName, 'multicall');
  const [deadline, inner] = call.args;
  assert.ok(deadline > BLOCK_TIME && deadline <= BLOCK_TIME + 600n, `deadline ${deadline}`);
  assert.equal(inner.length, 1);
  assert.equal(swap.value, 10n ** 18n);
});

test('a failed burn after the swap returns burnTx null instead of throwing', async () => {
  const { sender, sent } = stubSender(/^burn /);
  const dex = createUniswap({ rhc: stubRhc({}), net, sender, limits });
  const res = await dex.buyAndBurn(TOKEN, 10n ** 18n, 150);
  assert.equal(sent.length, 2);
  assert.deepEqual(res.swapTx, { chain: 'rhc', hash: '0x1' });
  assert.equal(res.amountOut, 7n);
  assert.equal(res.burnTx, null);
  assert.equal(res.burnUnconfirmed, null);
});

test('a burn that never confirms is reported with its hash so it is looked up before any retry', async () => {
  const { sender } = stubSender(null, /^burn /);
  const res = await createUniswap({ rhc: stubRhc({}), net, sender, limits }).buyAndBurn(TOKEN, 10n ** 18n, 150);
  assert.equal(res.burnTx, null);
  assert.deepEqual(res.burnUnconfirmed, { hash: '0x2', nonce: 2 });
});

test('a swap without a receipt throws only after handing its hash to onSwapBroadcast', async () => {
  const { sender } = stubSender(null, /^Uniswap/);
  const broadcasts: BroadcastTx[] = [];
  const dex = createUniswap({ rhc: stubRhc({}), net, sender, limits });
  await assert.rejects(dex.buyAndBurn(TOKEN, 10n ** 18n, 150, { onSwapBroadcast: (tx) => broadcasts.push(tx) }), /no receipt/);
  assert.deepEqual(broadcasts, [{ hash: '0x1', nonce: 1 }]);
});

test('a failed historical balance read falls back to the latest balance, then to the receipt Transfers', async () => {
  const fail = () => {
    throw new Error('missing trie node');
  };
  // Fee-on-transfer: the Transfer says 42, the wallet received 30.
  const latest = await createUniswap({ rhc: stubRhc({ balanceAfter: fail, balanceLatest: (n) => (n === 0 ? 0n : 30n) }), net, sender: stubSender(null).sender, limits }).buyAndBurn(TOKEN, 10n ** 18n, 150);
  assert.equal(latest.amountOut, 30n);
  const logs = await createUniswap({ rhc: stubRhc({ balanceAfter: fail, balanceLatest: (n) => (n === 0 ? 0n : fail()) }), net, sender: stubSender(null).sender, limits }).buyAndBurn(TOKEN, 10n ** 18n, 150);
  assert.equal(logs.amountOut, 42n);
  assert.notEqual(logs.burnTx, null);
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

test('a refusal after growing the TWAP history still reports that tx for gas booking', async () => {
  const { sender } = stubSender(null);
  const dex = createUniswap({ rhc: stubRhc({ cardinalityNext: 1, rate: () => 900n }), net, sender, limits });
  await assert.rejects(dex.buyAndBurn(TOKEN, 10n ** 18n, 150), (err: unknown) => {
    assert.ok(err instanceof PriceGuardError);
    assert.deepEqual(err.spent, { gasWei: GAS, tx: { chain: 'rhc', hash: '0x1' } });
    return true;
  });
});

test('a V4 buyback needs a reference price and refuses to pay too far over it', async () => {
  const refuse = async (opts: { referencePrice?: number }, kind: string) => {
    const { sender, sent } = stubSender(null);
    const dex = createUniswap({ rhc: stubRhc({ v4: true }), net, sender, limits });
    await assert.rejects(dex.buyAndBurn(TOKEN, 10n ** 18n, 150, opts), (err: unknown) => err instanceof PriceGuardError && err.kind === kind);
    assert.deepEqual(sent, []);
  };
  await refuse({}, 'no-twap');
  await refuse({ referencePrice: 1100 }, 'twap-deviation'); // pays ~909 bps over the reference (max 300)

  const { sender, sent } = stubSender(null);
  const dex = createUniswap({ rhc: stubRhc({ v4: true }), net, sender, limits });
  assert.equal(await dex.spotPrice(TOKEN), 1000);
  const res = await dex.buyAndBurn(TOKEN, 10n ** 18n, 150, { referencePrice: 1010 }); // ~99 bps over: within the limit
  assert.deepEqual(sent, [`Uniswap V4 buyback of ${TOKEN}`, `burn 7 of ${TOKEN}`]);
  assert.equal(res.amountOut, 7n);
});

test('spotPrice is null for tokens that do not trade on V4', async () => {
  const dex = createUniswap({ rhc: stubRhc({}), net, sender: null, limits: null });
  assert.equal(await dex.spotPrice(TOKEN), null);
});

test('burnHeld burns at most what the wallet holds and nothing when it holds none', async () => {
  let held = 5n;
  const { sender, sent } = stubSender(null);
  const dex = createUniswap({ rhc: stubRhc({ balanceLatest: () => held }), net, sender, limits });
  const partial = await dex.burnHeld(TOKEN, 8n);
  assert.equal(partial.amount, 5n);
  assert.equal(partial.gasWei, GAS);
  assert.deepEqual(sent, [`burn 5 of ${TOKEN}`]);
  held = 0n;
  const none = await dex.burnHeld(TOKEN, 8n);
  assert.deepEqual(none, { amount: 0n, tx: null, gasWei: 0n });
  assert.equal(sent.length, 1, 'nothing sent');
});

test('lookupTx tells pending, dropped and mined broadcasts apart', async () => {
  let receipt: TransactionReceipt | null = null;
  let minedNonce = 3;
  const burnLog: Log = { ...transferToWallet, topics: [transferToWallet.topics[0]!, pad(net.protocolAddress), pad(BURN_ADDRESS)], data: encodeAbiParameters([{ type: 'uint256' }], [9n]) };
  const stub = {
    getTransactionCount: async () => minedNonce,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      return receipt;
    },
    getTransaction: async () => ({ value: 123n }),
  };
  const dex = createUniswap({ rhc: stub as unknown as Client, net, sender: null, limits: null });
  const tx = { hash: '0xab', nonce: 3 };
  assert.deepEqual(await dex.lookupTx(tx, TOKEN), { status: 'pending' });
  minedNonce = 4; // nonce 3 was used by another tx
  assert.deepEqual(await dex.lookupTx(tx, TOKEN), { status: 'dropped' });
  receipt = { status: 'success', gasUsed: 2n, effectiveGasPrice: 3n, logs: [transferToWallet, burnLog] } as unknown as TransactionReceipt;
  assert.deepEqual(await dex.lookupTx(tx, TOKEN), { status: 'mined', ok: true, tx: { chain: 'rhc', hash: '0xab' }, gasWei: 6n, valueWei: 123n, received: 42n, burned: 9n });
});

test('lookupTx never mistakes an RPC failure for a dropped tx', async () => {
  const stub = {
    getTransactionCount: async () => 10,
    getTransactionReceipt: async () => {
      throw new Error('503 upstream');
    },
  };
  const dex = createUniswap({ rhc: stub as unknown as Client, net, sender: null, limits: null });
  await assert.rejects(dex.lookupTx({ hash: '0xab', nonce: 3 }, TOKEN), /503/);
});
