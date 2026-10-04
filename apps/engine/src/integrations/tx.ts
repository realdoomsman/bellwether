import { formatEther, TransactionReceiptNotFoundError } from 'viem';
import type { Address, TransactionReceipt } from 'viem';
import type { ChainKey } from '@bellwether/shared';
import { log } from '../log.ts';
import type { Hex, TxReceiptRef } from '../ports.ts';
import type { Client, Signer } from './chains.ts';
import { shortError } from './errors.ts';

const RECEIPT_TIMEOUT_MS = 180_000;
/** Headroom over `eth_estimateGas`; Orbit/Arbitrum estimates include a volatile L1 data component. */
const GAS_BUFFER_PCT = 25n;
const NONCE_ERROR = /nonce too (low|high)|invalid nonce|replacement transaction underpriced|already known|nonce has already been used/i;

export interface SendRequest {
  to: Address;
  data?: Hex;
  value?: bigint;
  /** Human label used in errors and logs, e.g. "Pons collectFees". */
  what: string;
  /**
   * Called synchronously once the tx is broadcast, before its receipt is awaited: persist a durable intent here
   * so a receipt timeout or a crash can still be resolved by hash (`TxSender.lookup`). A throw is logged, not fatal.
   */
  onBroadcast?: (hash: Hex, nonce: number) => void;
}

export interface Sent {
  ref: TxReceiptRef;
  receipt: TransactionReceipt;
  gasCostWei: bigint;
}

export type Send = (req: SendRequest) => Promise<Sent>;

/** Broadcast, but no receipt within the timeout: the tx may still land. Resolve it later with `TxSender.lookup(hash)`. */
export class UnconfirmedTxError extends Error {
  readonly hash: Hex;
  readonly nonce: number;
  constructor(message: string, hash: Hex, nonce: number) {
    super(message);
    this.name = 'UnconfirmedTxError';
    this.hash = hash;
    this.nonce = nonce;
  }
}

/** Mined but reverted: nothing happened except the gas it burned (`sent.gasCostWei`). */
export class RevertedTxError extends Error {
  readonly sent: Sent;
  constructor(message: string, sent: Sent) {
    super(message);
    this.name = 'RevertedTxError';
    this.sent = sent;
  }
}

export interface TxSender {
  address: Address;
  /**
   * Runs `fn` holding this chain's send lock: one in-flight tx per chain, so nonces never
   * collide and balance deltas measured inside `fn` are not interleaved with our other txs.
   */
  exclusive<T>(fn: (send: Send) => Promise<T>): Promise<T>;
  /** The mined outcome of an earlier broadcast (`receipt.status` may be 'reverted'); null while it has no receipt. */
  lookup(hash: Hex): Promise<Sent | null>;
  /** The wallet's mined nonce count (`latest`): a broadcast with a lower nonce and no receipt was dropped. */
  minedNonce(): Promise<number>;
}

/** Wraps `send` to total the gas of every tx it mined, including reverted ones (their gas is spent too). */
export function meter(send: Send): { send: Send; spent: () => { gasWei: bigint; tx: TxReceiptRef } | null } {
  let gas = 0n;
  let last: TxReceiptRef | null = null;
  const count = (sent: Sent) => {
    gas += sent.gasCostWei;
    last = sent.ref;
  };
  return {
    send: async (req) => {
      try {
        const sent = await send(req);
        count(sent);
        return sent;
      } catch (err) {
        if (err instanceof RevertedTxError) count(err.sent);
        throw err;
      }
    },
    /** Total gas so far and the last tx mined (a stable id to book it under); null before anything was mined. */
    spent: () => (last ? { gasWei: gas, tx: last } : null),
  };
}

function sentOf(chain: ChainKey, receipt: TransactionReceipt): Sent {
  return { ref: { chain, hash: receipt.transactionHash }, receipt, gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice };
}

export interface TxSenderOptions {
  chain: ChainKey;
  client: Client;
  signer: Signer;
  /** Value-carrying txs may not leave less than this native balance (gas reserve). */
  minBalanceWei?: bigint;
}

export function createTxSender(opts: TxSenderOptions): TxSender {
  const { chain, client, signer } = opts;
  const address = signer.account.address;
  let nextNonce: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const send: Send = async ({ to, data, value = 0n, what, onBroadcast }) => {
    const request = { account: address, to, data, value };
    try {
      await client.call(request);
    } catch (err) {
      throw new Error(`${what}: simulation reverted: ${shortError(err)}`);
    }
    const [gasEstimate, fees] = await Promise.all([client.estimateGas(request), client.estimateFeesPerGas()]);
    const gas = (gasEstimate * (100n + GAS_BUFFER_PCT)) / 100n;
    if (value > 0n && opts.minBalanceWei !== undefined) {
      const balance = await client.getBalance({ address });
      const left = balance - value - gas * fees.maxFeePerGas;
      if (left < opts.minBalanceWei) {
        throw new Error(
          `${what}: would leave ${formatEther(left)} ETH on ${chain}, below the ${formatEther(opts.minBalanceWei)} ETH gas reserve`,
        );
      }
    }

    let hash: Hex;
    let nonce: number;
    for (let attempt = 0; ; attempt++) {
      nonce = nextNonce ?? (await client.getTransactionCount({ address, blockTag: 'pending' }));
      try {
        hash = await signer.sendTransaction({
          to,
          data,
          value,
          gas,
          nonce,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        break;
      } catch (err) {
        nextNonce = null; // unknown nonce state: re-sync from the node next time
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && NONCE_ERROR.test(msg)) continue;
        throw new Error(`${what}: send failed: ${shortError(err)}`);
      }
    }
    nextNonce = nonce + 1;
    try {
      onBroadcast?.(hash, nonce);
    } catch (err) {
      log.error('Recording a broadcast tx failed; its receipt is still awaited', { what, hash, error: shortError(err) });
    }

    let receipt: TransactionReceipt;
    try {
      receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (err) {
      throw new UnconfirmedTxError(`${what}: no receipt for ${hash} (nonce ${nonce}): ${shortError(err)}`, hash, nonce);
    }
    const sent = sentOf(chain, receipt);
    if (receipt.status !== 'success') throw new RevertedTxError(`${what}: reverted on-chain in ${hash}`, sent);
    return sent;
  };

  return {
    address,
    exclusive<T>(fn: (send: Send) => Promise<T>): Promise<T> {
      const run = tail.then(() => fn(send));
      tail = run.catch(() => undefined);
      return run;
    },
    async lookup(hash) {
      try {
        return sentOf(chain, await client.getTransactionReceipt({ hash }));
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      }
    },
    minedNonce: () => client.getTransactionCount({ address, blockTag: 'latest' }),
  };
}
