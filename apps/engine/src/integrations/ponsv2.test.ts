import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, HttpRequestError, numberToHex, zeroAddress } from 'viem';
import type { Hex } from '../ports.ts';
import type { Client } from './chains.ts';
import {
  claimTag,
  createEscrowLedger,
  ESCROW_CONFIRMATIONS,
  ESCROW_RESCAN_BLOCKS,
  PONS_V2_ESCROW_ABI,
  ponsV2PoolKey,
  taggedClaimData,
} from './ponsv2.ts';

const TOKEN = '0xd7944AEA2d07D097295B3063D022042171175dfa';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';

test('a tagged escrow claim still decodes as claim(amount) and yields its token back', () => {
  const data = taggedClaimData(123_456_789n, TOKEN);
  const call = decodeFunctionData({ abi: PONS_V2_ESCROW_ABI, data });
  assert.equal(call.functionName, 'claim');
  assert.deepEqual(call.args, [123_456_789n]);
  assert.equal(claimTag(data), TOKEN.toLowerCase());
});

test('untagged, truncated or foreign calldata carries no tag', () => {
  const tagged = taggedClaimData(1n, TOKEN);
  assert.equal(claimTag(tagged.slice(0, 2 + 8 + 64) as `0x${string}`), null); // plain claim(uint256)
  assert.equal(claimTag(`${tagged}00` as `0x${string}`), null);
  assert.equal(claimTag(`0x4e71d92d${tagged.slice(10)}` as `0x${string}`), null); // claim() selector
});

test('pool key puts native ETH first and keeps the launch fee and tick spacing', () => {
  const key = ponsV2PoolKey({ token: TOKEN, pairToken: zeroAddress, poolFee: 0, tickSpacing: 200 }, HOOK);
  assert.deepEqual(key, { currency0: zeroAddress, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK });
  const pair = '0xffffffffffffffffffffffffffffffffffffffff';
  assert.equal(ponsV2PoolKey({ token: TOKEN, pairToken: pair, poolFee: 0, tickSpacing: 60 }, HOOK).currency0, TOKEN);
});

// ─── escrow ledger against a stubbed RPC ─────────────────────────────────────

const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
const FACTORY = '0x00000000000000000000000000000000000000fa';
const WALLET = '0x07430cbe35B0Fa683426B3cE8074f8A330312728';
const CURVE = '0x000000000000000000000000000000000000c0c0';
const ETH = 10n ** 18n;

interface StubLog {
  kind: 'credited' | 'claimed';
  block: bigint;
  amount: bigint;
  tx: Hex;
}

/**
 * A node holding `logs`, answering eth_getLogs only up to `served` (a lagging replica) and with head `head`.
 * `token()` on CURVE fails `curveFailures` times with HTTP 429 before answering TOKEN. The ledger waits
 * `rateLimitBackoffMs` between re-reads of a throttled range (none by default: a 429 fails the sync).
 */
function stubChain(rateLimitBackoffMs: readonly number[] = []) {
  const s = { head: 0n, served: null as bigint | null, logs: [] as StubLog[], curveFailures: 0, tokenCalls: 0 };
  const client = {
    getBlockNumber: async () => s.head,
    request: async ({ method, params }: { method: string; params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
      assert.equal(method, 'eth_getLogs');
      const from = BigInt(params[0].fromBlock);
      const to = BigInt(params[0].toBlock);
      const limit = s.served ?? s.head;
      return s.logs
        .filter((l) => l.block >= from && l.block <= to && l.block <= limit)
        .map((l) => {
          const [topics, data] =
            l.kind === 'credited'
              ? [encodeEventTopics({ abi: PONS_V2_ESCROW_ABI, eventName: 'Credited', args: { recipient: WALLET, source: CURVE } }), encodeAbiParameters([{ type: 'uint256' }], [l.amount])]
              : [encodeEventTopics({ abi: PONS_V2_ESCROW_ABI, eventName: 'Claimed', args: { recipient: WALLET } }), encodeAbiParameters([{ type: 'uint256' }], [l.amount])];
          return { address: ESCROW, topics, data, blockNumber: numberToHex(l.block), transactionHash: l.tx, logIndex: '0x0' };
        });
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'token') {
        s.tokenCalls++;
        if (s.curveFailures-- > 0) throw new HttpRequestError({ url: 'https://rpc.example', status: 429 });
        return TOKEN;
      }
      assert.equal(functionName, 'getLaunchedToken');
      return { token: TOKEN, curve: CURVE, exists: true };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const l = s.logs.find((x) => x.tx === hash)!;
      return { to: ESCROW, input: taggedClaimData(l.amount, TOKEN) };
    },
  };
  const ledger = createEscrowLedger({ rhc: client as unknown as Client, factory: FACTORY, hook: HOOK, escrow: ESCROW, wallet: WALLET, fromBlock: 1n, rateLimitBackoffMs });
  return { s, ledger };
}

const txHash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

test('a credit a lagging replica left out of a scanned range is picked up by the next sync, once', async () => {
  const { s, ledger } = stubChain();
  s.head = 100_000n;
  s.logs.push({ kind: 'credited', block: 90_000n, amount: ETH, tx: txHash(1) });
  s.logs.push({ kind: 'credited', block: 98_000n, amount: ETH / 2n, tx: txHash(2) });
  s.served = 95_000n; // the replica answering this getLogs is 5000 blocks behind: 98_000 is missing
  assert.equal(await ledger.unclaimed(TOKEN), ETH);
  s.served = null;
  s.head = 100_050n;
  assert.equal(await ledger.unclaimed(TOKEN), ETH + ETH / 2n);
  s.head = 100_100n;
  assert.equal(await ledger.unclaimed(TOKEN), ETH + ETH / 2n, 'the re-read window never double counts');
});

test('a claim a lagging replica left out is picked up, so the claimed fees are not claimed twice', async () => {
  const { s, ledger } = stubChain();
  s.head = 100_000n;
  s.logs.push({ kind: 'credited', block: 50_000n, amount: ETH, tx: txHash(1) });
  s.logs.push({ kind: 'claimed', block: 97_000n, amount: ETH, tx: txHash(2) });
  s.served = 96_000n;
  assert.equal(await ledger.unclaimed(TOKEN), ETH);
  s.served = null;
  s.head = 100_010n;
  assert.equal(await ledger.unclaimed(TOKEN), 0n);
});

test('logs shallower than the confirmation depth count now but vanish if reorged out', async () => {
  const { s, ledger } = stubChain();
  s.head = 100_000n;
  s.logs.push({ kind: 'credited', block: 100_000n - ESCROW_CONFIRMATIONS + 1n, amount: ETH, tx: txHash(1) });
  assert.equal(await ledger.unclaimed(TOKEN), ETH);
  s.logs.pop();
  s.head = 100_001n;
  assert.equal(await ledger.unclaimed(TOKEN), 0n);
  // Re-included later and then confirmed: counted exactly once.
  s.logs.push({ kind: 'credited', block: 100_005n, amount: ETH, tx: txHash(1) });
  s.head = 100_005n + ESCROW_CONFIRMATIONS;
  assert.equal(await ledger.unclaimed(TOKEN), ETH);
  s.head += ESCROW_RESCAN_BLOCKS / 2n;
  assert.equal(await ledger.unclaimed(TOKEN), ETH);
});

test('a 429 on the curve lookup fails the scan instead of dropping the credit; the next sync attributes it', async () => {
  const { s, ledger } = stubChain();
  s.head = 100_000n;
  s.logs.push({ kind: 'credited', block: 10_000n, amount: ETH, tx: txHash(1) });
  s.curveFailures = 1;
  await assert.rejects(ledger.unclaimed(TOKEN), /escrow log scan failed/);
  assert.equal(await ledger.unclaimed(TOKEN), ETH);
  assert.equal(s.tokenCalls, 2);
});

test('a throttled range is re-read after the backoff within the same sync; a longer throttle fails it', async () => {
  const { s, ledger } = stubChain([0, 0]);
  s.head = 100_000n;
  s.logs.push({ kind: 'credited', block: 10_000n, amount: ETH, tx: txHash(1) });
  s.curveFailures = 2;
  assert.equal(await ledger.unclaimed(TOKEN), ETH);
  assert.equal(s.tokenCalls, 3);

  const other = stubChain([0, 0]);
  other.s.head = 100_000n;
  other.s.logs.push({ kind: 'credited', block: 10_000n, amount: ETH, tx: txHash(1) });
  other.s.curveFailures = 3;
  await assert.rejects(other.ledger.unclaimed(TOKEN), /escrow log scan failed/);
});
