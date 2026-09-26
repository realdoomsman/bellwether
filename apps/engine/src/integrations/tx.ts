import { formatEther } from 'viem';
import type { Address, TransactionReceipt } from 'viem';
import type { ChainKey } from '@floor/shared';
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
}

export interface Sent {
  ref: TxReceiptRef;
  receipt: TransactionReceipt;
  gasCostWei: bigint;
}

export type Send = (req: SendRequest) => Promise<Sent>;

export interface TxSender {
  address: Address;
  /**
   * Runs `fn` holding this chain's send lock: one in-flight tx per chain, so nonces never
   * collide and balance deltas measured inside `fn` are not interleaved with our other txs.
   */
  exclusive<T>(fn: (send: Send) => Promise<T>): Promise<T>;
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

  const send: Send = async ({ to, data, value = 0n, what }) => {
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

    let receipt: TransactionReceipt;
    try {
      receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`${what}: no receipt for ${hash} (nonce ${nonce}): ${shortError(err)}`);
    }
    if (receipt.status !== 'success') throw new Error(`${what}: reverted on-chain in ${hash}`);
    return { ref: { chain, hash }, receipt, gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice };
  };

  return {
    address,
    exclusive<T>(fn: (send: Send) => Promise<T>): Promise<T> {
      const run = tail.then(() => fn(send));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
