import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError } from 'viem';
import type { Hex, TransactionReceipt } from 'viem';
import type { Client, Signer } from './chains.ts';
import { createTxSender, meter, RevertedTxError, UnconfirmedTxError } from './tx.ts';

const ADDRESS = '0x00000000000000000000000000000000000000a1';
const HASH: Hex = `0x${'ab'.repeat(32)}`;

function stub(receipt: TransactionReceipt | 'timeout') {
  const events: string[] = [];
  const client = {
    call: async () => ({}),
    estimateGas: async () => 21_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    getTransactionCount: async () => 4,
    waitForTransactionReceipt: async () => {
      events.push('wait');
      if (receipt === 'timeout') throw new WaitForTransactionReceiptTimeoutError({ hash: HASH });
      return receipt;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (receipt === 'timeout') throw new TransactionReceiptNotFoundError({ hash });
      return receipt;
    },
  };
  const signer = { account: { address: ADDRESS }, sendTransaction: async () => HASH };
  // Test doubles: only the client/signer members the sender calls.
  const sender = createTxSender({ chain: 'rhc', client: client as unknown as Client, signer: signer as unknown as Signer });
  return { sender, events };
}

const receipt = (status: 'success' | 'reverted') => ({ status, transactionHash: HASH, gasUsed: 21_000n, effectiveGasPrice: 3n }) as unknown as TransactionReceipt;

test('a broadcast is reported before its receipt is awaited, and a missing receipt keeps its hash and nonce', async () => {
  const { sender, events } = stub('timeout');
  const err = await sender
    .exclusive((send) => send({ to: ADDRESS, what: 'test tx', onBroadcast: (hash, nonce) => events.push(`broadcast ${hash} ${nonce}`) }))
    .catch((e: unknown) => e);
  assert.deepEqual(events, [`broadcast ${HASH} 4`, 'wait']);
  assert.ok(err instanceof UnconfirmedTxError);
  assert.equal(err.hash, HASH);
  assert.equal(err.nonce, 4);
  assert.equal(await sender.lookup(HASH), null, 'no receipt yet');
});

test('an on-chain revert carries the gas it burned, and meter counts it', async () => {
  const { sender } = stub(receipt('reverted'));
  const err = await sender
    .exclusive(async (raw) => {
      const m = meter(raw);
      const e = await m.send({ to: ADDRESS, what: 'test tx' }).catch((x: unknown) => x);
      assert.deepEqual(m.spent(), { gasWei: 63_000n, tx: { chain: 'rhc', hash: HASH } });
      return e;
    });
  assert.ok(err instanceof RevertedTxError);
  assert.equal(err.sent.gasCostWei, 63_000n);
  const found = await sender.lookup(HASH);
  assert.equal(found?.receipt.status, 'reverted');
  assert.equal(found?.gasCostWei, 63_000n);
});
