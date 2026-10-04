import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpRequestError } from 'viem';
import { loadConfig } from '../config.ts';
import type { Client } from './chains.ts';
import { createDiscovery } from './discovery.ts';

const net = loadConfig({ PROTOCOL_ADDRESS: '0x9838d8AA9bEc9209558a65A9950094927EA358cc' }).network;
const throttled = () => new HttpRequestError({ url: 'https://rpc.example', status: 429, body: {} });

/** An RPC at `head` that answers log queries with no logs, throttling the queries whose index is in `throttle`. */
function rpc(head: bigint, throttle: (call: number) => boolean) {
  const ranges: [bigint, bigint][] = [];
  let calls = 0;
  const client = {
    getBlockNumber: async () => head,
    request: async ({ params }: { params: [{ fromBlock: string; toBlock: string }] }) => {
      if (throttle(calls++)) throw throttled();
      ranges.push([BigInt(params[0].fromBlock), BigInt(params[0].toBlock)]);
      return [];
    },
  } as unknown as Client;
  return { client, ranges };
}

test('a first scan covers a bounded window of the backfill, in chunks the public RPC accepts', async () => {
  const { client, ranges } = rpc(10_000_000n, () => false);
  const res = await createDiscovery({ rhc: client, net, identify: async () => null }).scan(null);
  assert.equal(res.toBlock, 4_000_000n + 600_000n - 1n);
  assert.ok(ranges.every(([from, to]) => to - from + 1n <= 30_000n));
  assert.equal(ranges[0]![0], 4_000_000n);
});

test('throttled mid-scan: the covered blocks are kept and the next scan resumes after them', async () => {
  // Three queries per chunk (wallet at topic 1, 2, 3): the second chunk's first query is throttled.
  const { client } = rpc(10_000_000n, (call) => call === 3);
  const discovery = createDiscovery({ rhc: client, net, identify: async () => null });
  const res = await discovery.scan(5_000_000n);
  assert.equal(res.toBlock, 5_000_000n + 30_000n - 1n);
});

test('throttled on the very first chunk: the scan fails so the run is retried', async () => {
  const { client } = rpc(10_000_000n, () => true);
  await assert.rejects(createDiscovery({ rhc: client, net, identify: async () => null }).scan(5_000_000n), /discovery log scan failed/);
});
