/**
 * Discovery: launchpads emit events that index the fee-recipient wallet (e.g. the Pons V1 locker's
 * (token, recipient) event at launch and on every fee collection, the Pons V2 fee escrow's
 * Credited(recipient, curve) on every sweep). Scan chain-wide for logs with the protocol wallet as an
 * indexed topic, harvest the emitter and every address-shaped topic (a Pons V2 curve stands for its
 * token), and keep those a supported launchpad factory launched (per the factories' registries).
 * Candidates are unverified: core runs Launchpad.verify on each.
 */
import { getAddress, numberToHex } from 'viem';
import type { Address } from 'viem';
import type { LaunchpadId } from '@stepup/shared';
import type { Discovery, NetworkConfig } from '../ports.ts';
import type { Client } from './chains.ts';
import { isRateLimited, shortError } from './errors.ts';
import { addressTopic, topicAddress, topicsAt } from './hex.ts';
import type { LaunchOrigin } from './launchpads.ts';
import { ponsV2TokenOfCurve } from './ponsv2.ts';

/**
 * Topic-filtered log queries over millions of sparse blocks return in well under a second on the
 * public RHC RPC, but dense ranges time out or exceed the 10k-log cap: shrink the window then.
 * Rate limiting (HTTP 429, already retried with backoff by the transport) is not a range problem.
 */
const MAX_CHUNK_BLOCKS = 2_000_000n;
const MIN_CHUNK_BLOCKS = 20_000n;
/** First scan looks back ~1 week (RHC produces ~10 blocks/s). */
const BACKFILL_BLOCKS = 6_000_000n;

/** Emitter plus every address-shaped indexed topic except the wallet itself. */
export function extractCandidates(log: { address: string; topics: readonly string[] }, wallet: Address): Address[] {
  const walletTopic = addressTopic(wallet);
  const out = new Set<Address>([log.address.toLowerCase() as Address]);
  for (const topic of log.topics.slice(1)) {
    if (topic.toLowerCase() === walletTopic) continue;
    const addr = topicAddress(topic);
    if (addr) out.add(addr);
  }
  return [...out];
}

export interface DiscoveryDeps {
  rhc: Client;
  net: NetworkConfig;
  identify(token: Address): Promise<LaunchOrigin | null>;
}

export function createDiscovery({ rhc, net, identify }: DiscoveryDeps): Discovery {
  const wallet = net.protocolAddress;
  const walletTopic = addressTopic(wallet);
  const c = net.contracts;
  const infrastructure = new Set(
    [
      wallet,
      c.weth,
      c.uniswapRouter,
      c.uniswapQuoter,
      c.uniswapUniversalRouter,
      c.ponsFactory,
      c.ponsLocker,
      c.ponsV2Factory,
      c.ponsV2Hook,
      c.ponsV2FeeEscrow,
      c.launchhoodFactory,
      c.launchhoodLocker,
    ]
      .filter((a): a is Address => a !== null)
      .map((a) => a.toLowerCase()),
  );

  /** Sequential on purpose: the public RHC RPC rate-limits eth_getLogs bursts (~25 per few seconds). */
  async function logsMentioningWallet(from: bigint, to: bigint) {
    const range = { fromBlock: numberToHex(from), toBlock: numberToHex(to) };
    const logs = [];
    for (const pos of [1, 2, 3] as const) {
      logs.push(...(await rhc.request({ method: 'eth_getLogs', params: [{ ...range, topics: topicsAt(pos, walletTopic) }] })));
    }
    return logs;
  }

  return {
    async scan(fromBlock) {
      const latest = await rhc.getBlockNumber();
      const found = new Set<Address>();
      let chunk = MAX_CHUNK_BLOCKS;
      for (let from = fromBlock ?? (latest > BACKFILL_BLOCKS ? latest - BACKFILL_BLOCKS : 0n); from <= latest; ) {
        const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
        let logs;
        try {
          logs = await logsMentioningWallet(from, to);
        } catch (err) {
          if (chunk > MIN_CHUNK_BLOCKS && !isRateLimited(err)) {
            chunk /= 4n;
            continue;
          }
          throw new Error(`discovery log scan failed for blocks ${from}-${to}: ${shortError(err)}`);
        }
        for (const l of logs) {
          for (const addr of extractCandidates(l, wallet)) if (!infrastructure.has(addr)) found.add(addr);
        }
        from = to + 1n;
        if (chunk < MAX_CHUNK_BLOCKS) chunk *= 2n;
      }

      const candidates: { token: Address; launchpad: LaunchpadId }[] = [];
      for (const addr of found) {
        let token: Address | null = addr;
        let origin = await identify(addr);
        if (!origin) {
          token = await ponsV2TokenOfCurve(rhc, c.ponsV2Factory, addr);
          origin = token ? await identify(token) : null;
        }
        if (token && origin && !candidates.some((x) => x.token.toLowerCase() === token.toLowerCase())) {
          candidates.push({ token: getAddress(token), launchpad: origin.launchpad });
        }
      }
      return { candidates, toBlock: latest };
    },
  };
}
