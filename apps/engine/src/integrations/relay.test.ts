import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { createRelayBridge, DEFAULT_RELAY_DEPOSIT_CONTRACTS, validateRelayQuote, type RelayQuote } from './relay.ts';
import type { Sent, TxSender } from './tx.ts';
import { loadConfig } from '../config.ts';

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const STRANGER: Address = '0x2222222222222222222222222222222222222222';
const USDC: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
/** Relay's own published ERC-20 router on RHC: listed by Relay's API, but not a deposit target. */
const RELAY_ROUTER: Address = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
const AMOUNT = parseEther('0.02');
const ABI = parseAbi(['function depositNative(address depositor, bytes32 id)']);
const ORDER_ID = `0x${'ab'.repeat(32)}` as const;
const REQUEST_ID = `0x${'cd'.repeat(32)}`;

/** Shape of a live RHC ETH → Arbitrum USDC quote (0.02 ETH ≈ $53.50). */
function quote(patch: { to?: Address; depositor?: Address; usdcOut?: string; data?: Hex; orderId?: Hex; impact?: unknown } = {}): RelayQuote {
  return {
    steps: [
      {
        id: 'deposit',
        kind: 'transaction',
        requestId: REQUEST_ID,
        items: [
          {
            data: {
              from: WALLET,
              to: patch.to ?? DEFAULT_RELAY_DEPOSIT_CONTRACTS[0]!,
              data: patch.data ?? encodeFunctionData({ abi: ABI, functionName: 'depositNative', args: [patch.depositor ?? WALLET, patch.orderId ?? ORDER_ID] }),
              value: AMOUNT.toString(),
              chainId: 4663,
            },
          },
        ],
      },
    ],
    protocol: { v2: { orderId: ORDER_ID } },
    details: {
      recipient: WALLET,
      currencyOut: { currency: { chainId: 42161, address: USDC }, amount: patch.usdcOut ?? '53502482' },
      totalImpact: { percent: ('impact' in patch ? patch.impact : '-0.53') as string },
    },
  };
}

const expect = {
  wallet: WALLET,
  amountWei: AMOUNT,
  arbitrumUsdc: USDC,
  maxImpactPct: 0.02,
  minUsdc: 0.02 * 2700 * 0.98,
  depositContracts: DEFAULT_RELAY_DEPOSIT_CONTRACTS,
  chain: { id: 4663, disabled: false, depositEnabled: true },
};

test('a deposit to the pinned Relay depository crediting our wallet passes', () => {
  const { deposit, requestId, expectedUsdc } = validateRelayQuote(quote(), expect);
  assert.equal(deposit.to, DEFAULT_RELAY_DEPOSIT_CONTRACTS[0]);
  assert.equal(deposit.value, AMOUNT);
  assert.equal(requestId, REQUEST_ID);
  assert.equal(expectedUsdc, 53.502482);
});

test('Relay quotes are refused when the target, depositor or output fails an independent check', () => {
  const plain = encodeFunctionData({ abi: ABI, functionName: 'depositNative', args: [WALLET, ORDER_ID] });
  const noRequest = quote();
  delete noRequest.steps[0]!.requestId;
  const cases: [string, RelayQuote, RegExp][] = [
    ['a Relay-published contract that is not the pinned depository', quote({ to: RELAY_ROUTER }), /not a pinned Relay depository/],
    ['calldata that credits someone else', quote({ depositor: STRANGER }), /deposit credits/],
    ['output below the engine-priced floor despite a small self-reported impact', quote({ usdcOut: '40000000' }), /below the \$52\.92 floor/],
    ['calldata with bytes appended past the two arguments', quote({ data: `${plain}deadbeef` }), /bytes beyond depositNative/],
    ['a zero order id', quote({ orderId: `0x${'00'.repeat(32)}` }), /zero order id/],
    ['an order id that is not the quoted order', quote({ orderId: `0x${'ef'.repeat(32)}` }), /not the quoted order/],
    ['no request id to look the deposit up by', noRequest, /request id/],
    ['impact above the cap', quote({ impact: '-2.5' }), /price impact 2\.50% exceeds/],
  ];
  for (const [label, q, reason] of cases) assert.throws(() => validateRelayQuote(q, expect), reason, label);
  const garbage = quote();
  garbage.steps[0]!.items[0]!.data.data = '0xdeadbeef';
  assert.throws(() => validateRelayQuote(garbage, expect), /not a Relay depositNative call/);
});

test('a missing or non-numeric price impact is refused instead of passing every bound', () => {
  for (const impact of [undefined, null, '', 'n/a', {}]) {
    assert.throws(() => validateRelayQuote(quote({ impact }), expect), /price impact .* is not a number/, JSON.stringify(impact) ?? 'undefined');
  }
});

const HASH = `0x${'aa'.repeat(32)}` as Hex;
const net = { ...loadConfig({ ENGINE_MODE: 'paper' }).network, protocolAddress: WALLET };

/** A bridge over a fake RHC sender (receipts by hash) and a stubbed Relay API (status by request id, quotes). */
function harness(opts: { relay?: () => Response; receipts?: Map<string, { from: Address; status: 'success' | 'reverted' }>; minedNonce?: number } = {}) {
  const receipts = opts.receipts ?? new Map();
  const events: string[] = [];
  const sentFor = (hash: Hex): Sent => {
    const r = receipts.get(hash)!;
    return {
      ref: { chain: 'rhc', hash },
      receipt: { ...r, gasUsed: 100_000n, effectiveGasPrice: 10n } as unknown as Sent['receipt'], // only the fields the bridge reads
      gasCostWei: 1_000_000n,
    };
  };
  const sender = {
    address: WALLET,
    exclusive: async (fn) =>
      fn(async (req) => {
        events.push('send');
        req.onBroadcast?.(HASH, 7);
        receipts.set(HASH, { from: WALLET, status: 'success' });
        return sentFor(HASH);
      }),
    lookup: async (hash: Hex) => (receipts.has(hash) ? sentFor(hash) : null),
    minedNonce: async () => opts.minedNonce ?? 0,
  } as TxSender;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/intents/status/')) return opts.relay ? opts.relay() : Response.json({ status: 'waiting' });
    if (url.endsWith('/chains')) return Response.json({ chains: [{ id: 4663, disabled: false, depositEnabled: true }] });
    if (url.endsWith('/quote')) {
      const q = quote();
      q.steps[0]!.items[0]!.data.from = WALLET;
      return Response.json(q);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const bridge = createRelayBridge({ net, apiUrl: 'https://relay.test', depositContracts: DEFAULT_RELAY_DEPOSIT_CONTRACTS, sender });
  return { bridge, events, receipts, restore: () => (globalThis.fetch = realFetch) };
}

test('ethToUsdc hands out the request id before signing and the hash on broadcast', async () => {
  const h = harness();
  try {
    const res = await h.bridge.ethToUsdc(AMOUNT, 0.02, 0, {
      prepared: (d) => h.events.push(`prepared ${d.requestId}`),
      broadcast: (tx) => h.events.push(`broadcast ${tx.hash}`),
    });
    assert.deepEqual(h.events, [`prepared ${REQUEST_ID}`, 'send', `broadcast ${HASH}`]);
    assert.equal(res.gasWei, 1_000_000n);
  } finally {
    h.restore();
  }
});

test('depositStatus settles a deposit from its receipt, with Relay finding a hash that was never recorded', async () => {
  const cases: [string, Parameters<typeof harness>[0], string | null, string][] = [
    ['recorded hash, mined', { receipts: new Map([[HASH, { from: WALLET, status: 'success' }]]) }, HASH, 'landed'],
    ['recorded hash, reverted', { receipts: new Map([[HASH, { from: WALLET, status: 'reverted' }]]) }, HASH, 'reverted'],
    ['recorded hash, Relay refunded it', { receipts: new Map([[HASH, { from: WALLET, status: 'success' }]]), relay: () => Response.json({ status: 'refund', inTxHashes: [HASH] }) }, HASH, 'refunded'],
    ['recorded hash, no receipt yet', {}, HASH, 'pending'],
    ['recorded hash, Relay unreachable', { receipts: new Map([[HASH, { from: WALLET, status: 'success' }]]), relay: () => new Response('down', { status: 503 }) }, HASH, 'landed'],
    ['no hash, Relay saw our deposit', { receipts: new Map([[HASH, { from: WALLET, status: 'success' }]]), relay: () => Response.json({ status: 'success', inTxHashes: [HASH] }) }, null, 'landed'],
    ['no hash, Relay points at a stranger tx', { receipts: new Map([[HASH, { from: STRANGER, status: 'success' }]]), relay: () => Response.json({ status: 'success', inTxHashes: [HASH] }) }, null, 'unknown'],
    ['no hash, Relay still waiting', {}, null, 'unknown'],
    ['no hash, Relay unknown request', { relay: () => new Response('not found', { status: 404 }) }, null, 'unknown'],
    ['no hash, Relay processing without hashes yet', { relay: () => Response.json({ status: 'depositing' }) }, null, 'pending'],
  ];
  for (const [label, opts, hash, state] of cases) {
    const h = harness(opts);
    try {
      const status = await h.bridge.depositStatus({ requestId: REQUEST_ID, hash });
      assert.equal(status.state, state, label);
      if ('gasWei' in status) assert.equal(status.gasWei, 1_000_000n, label);
    } finally {
      h.restore();
    }
  }
});

test('a landed deposit is filled only once Relay reports the output delivered', async () => {
  for (const [relayStatus, filled] of [['pending', false], ['success', true]] as const) {
    const h = harness({ receipts: new Map([[HASH, { from: WALLET, status: 'success' }]]), relay: () => Response.json({ status: relayStatus, inTxHashes: [HASH] }) });
    try {
      const status = await h.bridge.depositStatus({ requestId: REQUEST_ID, hash: HASH });
      assert.equal(status.state === 'landed' && status.filled, filled, relayStatus);
    } finally {
      h.restore();
    }
  }
});

test('without a recorded hash an unreachable Relay is an error, never "unknown"', async () => {
  const h = harness({ relay: () => new Response('down', { status: 503 }) });
  try {
    await assert.rejects(h.bridge.depositStatus({ requestId: REQUEST_ID, hash: null }), /HTTP 503/);
  } finally {
    h.restore();
  }
});

test('a recorded deposit without a receipt is dropped once its nonce was mined by another tx', async () => {
  const cases: [string, Parameters<typeof harness>[0], number | null, string][] = [
    ['nonce mined past ours, no receipt', { minedNonce: 8 }, 7, 'dropped'],
    ['nonce not mined yet', { minedNonce: 7 }, 7, 'pending'],
    ['nonce unknown (older intent)', { minedNonce: 99 }, null, 'pending'],
    ['nonce mined past ours, our receipt exists', { minedNonce: 8, receipts: new Map([[HASH, { from: WALLET, status: 'success' }]]) }, 7, 'landed'],
  ];
  for (const [label, opts, nonce, state] of cases) {
    const h = harness(opts);
    try {
      assert.equal((await h.bridge.depositStatus({ requestId: REQUEST_ID, hash: HASH, nonce })).state, state, label);
    } finally {
      h.restore();
    }
  }
});

test('ethToUsdc hands the broadcast nonce to the hook', async () => {
  const h = harness();
  try {
    let seen: number | undefined;
    await h.bridge.ethToUsdc(AMOUNT, 0.02, 0, { broadcast: (_tx, nonce) => (seen = nonce) });
    assert.equal(seen, 7);
  } finally {
    h.restore();
  }
});
