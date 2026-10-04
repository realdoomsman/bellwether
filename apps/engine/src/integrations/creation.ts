/**
 * The launch transaction of a token, for the reference's fee-routing fallback (the launch calldata
 * or events name the fee wallet) when a launchpad's fee-recipient getter is unavailable.
 *
 * Both launchpad factories emit a launch event whose first indexed topic is the new token
 * (Pons 0x14613701…, LaunchHood 0x4c27a723…), inside the tx that mints the token's supply. So the
 * earliest factory log indexing the token, in a tx where the token mints, is the launch.
 * Full-history log queries are slow for busy tokens (bloom hits in every block they trade), so
 * this is not the primary origin check; Blockscout is the fallback when the RPC fails.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { isAddressEqual, numberToHex, zeroAddress } from 'viem';
import type { Address, Log } from 'viem';
import type { LaunchpadId } from '@bellwether/shared';
import type { Hex } from '../ports.ts';
import type { Client } from './chains.ts';
import { shortError } from './errors.ts';
import { addressTopic, hexMentionsAddress } from './hex.ts';
import { fetchJson } from './http.ts';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The public RHC RPC sporadically answers full-history log queries with "log query timed out" under load. */
const LOG_QUERY_ATTEMPTS = 3;
const LOG_QUERY_RETRY_MS = 1_500;
/** The public RHC RPC refuses address-filtered log queries over more than 10M blocks (measured 2026-10-04). */
const LOG_WINDOW_BLOCKS = 10_000_000n;

export interface Launch {
  launchpad: LaunchpadId;
  txHash: Hex;
  /** EOA that sent the launch tx. */
  deployer: Address;
  input: Hex;
  logs: Log[];
}

/** The first factory event naming `token`: its launch. Scans newest window first, all the way back to genesis. */
async function factoryAnnouncementTx(rhc: Client, factories: Address[], token: Address): Promise<Hex | null> {
  const tokenTopic = addressTopic(token);
  const head = await rhc.getBlockNumber();
  let first: { block: bigint; index: bigint; tx: Hex } | null = null;
  for (let to = head; to >= 0n; to -= LOG_WINDOW_BLOCKS) {
    const from = to >= LOG_WINDOW_BLOCKS - 1n ? to - LOG_WINDOW_BLOCKS + 1n : 0n;
    for (let attempt = 1; ; attempt++) {
      try {
        const logs = await rhc.request({
          method: 'eth_getLogs',
          params: [{ address: factories, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics: [null, tokenTopic] }],
        });
        for (const l of logs) {
          if (!l.blockNumber || !l.logIndex || !l.transactionHash) continue;
          const block = BigInt(l.blockNumber);
          const index = BigInt(l.logIndex);
          if (!first || block < first.block || (block === first.block && index < first.index)) first = { block, index, tx: l.transactionHash };
        }
        break;
      } catch (err) {
        if (attempt >= LOG_QUERY_ATTEMPTS || !/timed out/i.test(shortError(err))) throw err;
        await sleep(LOG_QUERY_RETRY_MS * attempt);
      }
    }
    if (from === 0n) break;
  }
  return first?.tx ?? null;
}

async function blockscoutCreationTx(blockscoutUrl: string, token: Address): Promise<Hex | null> {
  const data = await fetchJson<{ creation_transaction_hash?: Hex | null }>('Blockscout', `${blockscoutUrl}/api/v2/addresses/${token}`);
  return data.creation_transaction_hash ?? null;
}

/**
 * The launch of `token` by one of `factories`, or null if no supported factory launched it.
 * Throws only when neither the RPC nor Blockscout can answer.
 */
export async function findLaunch(
  rhc: Client,
  blockscoutUrl: string,
  factories: Record<LaunchpadId, Address>,
  token: Address,
): Promise<Launch | null> {
  let txHash: Hex | null;
  try {
    txHash = await factoryAnnouncementTx(rhc, Object.values(factories), token);
  } catch (rpcErr) {
    try {
      txHash = await blockscoutCreationTx(blockscoutUrl, token);
    } catch (bsErr) {
      throw new Error(`launch lookup failed (RPC: ${shortError(rpcErr)}; ${shortError(bsErr)})`);
    }
  }
  if (!txHash) return null;

  const [tx, receipt] = await Promise.all([rhc.getTransaction({ hash: txHash }), rhc.getTransactionReceipt({ hash: txHash })]);
  const minted = receipt.logs.some(
    (l) => isAddressEqual(l.address, token) && l.topics[0] === TRANSFER_TOPIC && l.topics[1] === addressTopic(zeroAddress),
  );
  if (!minted) return null;
  const launchpad = (Object.keys(factories) as LaunchpadId[]).find((id) =>
    receipt.logs.some(
      (l) => isAddressEqual(l.address, factories[id]) && (l.topics.some((t) => hexMentionsAddress(t, token)) || hexMentionsAddress(l.data, token)),
    ),
  );
  return launchpad ? { launchpad, txHash, deployer: tx.from, input: tx.input, logs: receipt.logs } : null;
}

/** Launch-tx fallback when a launchpad has no fee-recipient getter: the wallet is ABI-encoded in the launch calldata or events. */
export function launchMentions(launch: Launch, wallet: Address): boolean {
  return (
    hexMentionsAddress(launch.input, wallet) ||
    launch.logs.some((l) => hexMentionsAddress(l.data, wallet) || l.topics.some((t) => hexMentionsAddress(t, wallet)))
  );
}
