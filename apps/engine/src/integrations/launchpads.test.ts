import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, pad, toEventSelector, TransactionReceiptNotFoundError, zeroAddress } from 'viem';
import type { Address, Hex, Log, TransactionReceipt } from 'viem';
import { loadConfig } from '../config.ts';
import type { Client } from './chains.ts';
import { createLaunchpads } from './launchpads.ts';
import { RevertedTxError, UnconfirmedTxError } from './tx.ts';
import type { Sent, SendRequest, TxSender } from './tx.ts';

const net = { ...loadConfig({ ENGINE_MODE: 'paper' }).network, protocolAddress: '0x00000000000000000000000000000000000000a1' as Address };
const WETH = net.contracts.weth;
const TOKEN: Address = '0x7f0404070cf6FB703af9f3B89f84Af3FFE2A54B3';
const GAS = 1_000n;
const WETH_FEES = 5_000_000n;
const START = 100n;
const BALANCE = 10n ** 18n;

const transfer = (token: Address, amount: bigint): Log => ({
  address: token,
  topics: [toEventSelector('Transfer(address,address,uint256)'), pad(net.contracts.ponsLocker), pad(net.protocolAddress)],
  data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  blockHash: null,
  blockNumber: null,
  logIndex: null,
  transactionHash: null,
  transactionIndex: null,
  removed: false,
});

/** A Pons V1 token whose collectFees pays WETH_FEES of WETH and `tokens` of the memecoin, of which the wallet ends up holding `held`. */
function stubRhc({ tokens, held, weth = WETH_FEES }: { tokens: bigint; held: bigint; weth?: bigint }): Client {
  const stub = {
    async readContract(p: { address: Address; functionName: string }) {
      if (p.functionName === 'getLaunchedToken') return { exists: false, token: zeroAddress };
      if (p.functionName === 'balanceOf') return p.address === WETH ? weth : held;
      throw new Error(`unexpected read ${p.functionName}`);
    },
    async simulateBlocks() {
      return [{ calls: [{ status: 'success', logs: [transfer(WETH, WETH_FEES), transfer(TOKEN, tokens)] }] }];
    },
    async getBlockNumber() {
      return START;
    },
    // Only gas leaves the native balance during the claim calls (fees arrive as WETH).
    async getBalance({ blockNumber }: { blockNumber?: bigint }) {
      return BALANCE - GAS * (blockNumber! - START);
    },
  };
  return stub as unknown as Client;
}

function stubSender(opts: { claimReverts?: boolean; burnUnconfirmed?: boolean; claimUnconfirmed?: boolean } = {}) {
  const sent: string[] = [];
  let block = START;
  const sender: TxSender = {
    address: net.protocolAddress,
    exclusive: (fn) =>
      fn(async (req: SendRequest): Promise<Sent> => {
        sent.push(req.what);
        const hash: Hex = `0x${sent.length}`;
        const isClaim = req.what.includes('fee claim');
        const logs = isClaim ? [transfer(WETH, WETH_FEES), transfer(TOKEN, 10n)] : [];
        // Test double: the receipt fields claim() reads.
        const sentTx = { ref: { chain: 'rhc' as const, hash }, receipt: { blockNumber: ++block, logs } as unknown as TransactionReceipt, gasCostWei: GAS };
        if (isClaim && opts.claimReverts) throw new RevertedTxError(`${req.what}: reverted on-chain in ${hash}`, sentTx);
        if (isClaim && opts.claimUnconfirmed) {
          req.onBroadcast?.(hash, 41);
          throw new UnconfirmedTxError(`${req.what}: no receipt for ${hash}`, hash, 41);
        }
        if (req.what.startsWith('burn') && opts.burnUnconfirmed) throw new UnconfirmedTxError(`${req.what}: no receipt for ${hash}`, hash, 9);
        return sentTx;
      }),
    lookup: async () => null,
    minedNonce: async () => 0,
  };
  return { sender, sent };
}

test('a claim reports the gas of every tx it sent and burns only the memecoin that actually arrived', async () => {
  const { sender, sent } = stubSender();
  // Fee-on-transfer: the Transfer says 10, the wallet holds 8.
  const { launchpads } = createLaunchpads({ rhc: stubRhc({ tokens: 10n, held: 8n }), net, sender });
  const res = await launchpads.pons.claim(TOKEN);
  assert.deepEqual(sent, ['Pons fee claim', 'WETH unwrap', `burn 8 of ${TOKEN}`]);
  assert.equal(res!.amountWei, WETH_FEES, 'gross fees: the claim call only spent gas natively');
  assert.equal(res!.gasWei, 3n * GAS, 'claim + unwrap + burn');
  assert.equal(res!.tokensBurned?.amount, 8n);
  assert.equal(res!.tokensUnburned, null);
});

test('memecoin whose burn did not confirm is reported as unburned with the burn to look up, not dropped', async () => {
  const { sender } = stubSender({ burnUnconfirmed: true });
  const { launchpads } = createLaunchpads({ rhc: stubRhc({ tokens: 10n, held: 10n }), net, sender });
  const res = await launchpads.pons.claim(TOKEN);
  assert.equal(res!.tokensBurned, null);
  assert.deepEqual(res!.tokensUnburned, { amount: 10n, burnUnconfirmed: { hash: '0x3', nonce: 9 } });
  assert.equal(res!.amountWei, WETH_FEES, 'the ETH leg is still reported');
});

test('a claim that reverted on-chain reports the gas it burned instead of throwing it away', async () => {
  const { sender } = stubSender({ claimReverts: true });
  const { launchpads } = createLaunchpads({ rhc: stubRhc({ tokens: 10n, held: 0n, weth: 0n }), net, sender });
  const res = await launchpads.pons.claim(TOKEN);
  assert.equal(res!.amountWei, 0n);
  assert.equal(res!.gasWei, GAS);
  assert.equal(res!.tx.hash, '0x1');
});

test('a claim call is reported when broadcast, so a receipt timeout leaves it to look up', async () => {
  const { sender, sent } = stubSender({ claimUnconfirmed: true });
  const { launchpads } = createLaunchpads({ rhc: stubRhc({ tokens: 10n, held: 10n }), net, sender });
  const broadcasts: { hash: string; nonce: number }[] = [];
  await assert.rejects(launchpads.pons.claim(TOKEN, (tx) => broadcasts.push(tx)), UnconfirmedTxError);
  assert.deepEqual(broadcasts, [{ hash: '0x1', nonce: 41 }]);
  assert.deepEqual(sent, ['Pons fee claim'], 'nothing else is sent behind it');
});

interface LookupChain {
  minedNonce: number;
  receipt: TransactionReceipt | null;
  /** Wallet txs mined in block 50 (the receipt's block). */
  noncesInBlock?: number;
  /** Native ETH the claim call paid the wallet in block 50. */
  nativeIn?: bigint;
}

/** RHC reads lookupClaim makes: the wallet's mined nonce, the receipt, and balance/nonce at blocks 49 and 50. */
function lookupRhc(o: LookupChain): Client {
  const stub = {
    async getTransactionCount({ blockNumber }: { blockNumber?: bigint }) {
      if (blockNumber === undefined) return o.minedNonce;
      return blockNumber === 50n ? 10 + (o.noncesInBlock ?? 1) : 10;
    },
    async getTransactionReceipt() {
      if (!o.receipt) throw new TransactionReceiptNotFoundError({ hash: '0xab' });
      return o.receipt;
    },
    async getBalance({ blockNumber }: { blockNumber: bigint }) {
      return blockNumber === 50n ? BALANCE + (o.nativeIn ?? 0n) - GAS : BALANCE;
    },
  };
  return stub as unknown as Client;
}

test('lookupClaim tells pending and dropped apart and reads a late claim payout from its receipt and block', async () => {
  const lookup = (o: LookupChain) => createLaunchpads({ rhc: lookupRhc(o), net, sender: null }).launchpads.launchhood.lookupClaim!(TOKEN, { hash: '0xab', nonce: 7 });
  assert.deepEqual(await lookup({ minedNonce: 7, receipt: null }), { status: 'pending' });
  assert.deepEqual(await lookup({ minedNonce: 8, receipt: null }), { status: 'dropped' });

  const receipt = (status: 'success' | 'reverted') =>
    ({ status, blockNumber: 50n, gasUsed: GAS, effectiveGasPrice: 1n, logs: [transfer(WETH, 5n), transfer(TOKEN, 9n)] }) as unknown as TransactionReceipt;
  const tx = { chain: 'rhc', hash: '0xab' };
  // Native payout = the block's balance change plus this call's gas; WETH and memecoin come from the logs.
  assert.deepEqual(await lookup({ minedNonce: 11, receipt: receipt('success'), nativeIn: 700n }), {
    status: 'mined', ok: true, tx, gasWei: GAS, amountWei: 705n, tokens: 9n, nativeUnknown: false,
  });
  // Another wallet tx in the same block: its flows can't be told apart, so only the WETH is counted.
  assert.deepEqual(await lookup({ minedNonce: 12, receipt: receipt('success'), nativeIn: 700n, noncesInBlock: 2 }), {
    status: 'mined', ok: true, tx, gasWei: GAS, amountWei: 5n, tokens: 9n, nativeUnknown: true,
  });
  assert.deepEqual(await lookup({ minedNonce: 11, receipt: receipt('reverted') }), {
    status: 'mined', ok: false, tx, gasWei: GAS, amountWei: 0n, tokens: 0n, nativeUnknown: false,
  });
});
