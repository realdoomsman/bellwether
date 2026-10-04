import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { isAddressEqual, recoverTypedDataAddress, zeroAddress } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { HlInfo } from './info.ts';
import { actionHash, SEND_ASSET_FIELDS } from './signing.ts';
import type { HlSignature } from './signing.ts';
import { createHyperliquidVenue, takerFeeRate } from './venue.ts';

interface Posted {
  action: Record<string, unknown> & { signatureChainId?: Hex };
  nonce: number;
  signature: HlSignature;
}

const account = privateKeyToAccount(generatePrivateKey());

/** Minimal Hyperliquid API: one builder dex with AAPL; /exchange records the request and rejects it. */
function stubHyperliquid(t: TestContext): Posted[] {
  const posted: Posted[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/exchange')) {
      posted.push(body);
      return json({ status: 'err', response: 'User or API Wallet does not exist.' });
    }
    switch (body.type) {
      case 'perpDexs':
        return json([null, { name: 'xyz' }]);
      case 'metaAndAssetCtxs':
        return json([
          { universe: [{ name: 'xyz:AAPL', szDecimals: 3, maxLeverage: 20 }], collateralToken: 0 },
          [{ markPx: '340.1', midPx: '340.1', prevDayPx: '336' }],
        ]);
      case 'spotMeta':
        return json({ tokens: [{ index: 0, name: 'USDC', tokenId: '0x6d1e7cde53ba9467b783cb7c530ce054' }] });
      case 'clearinghouseState':
        return json({ marginSummary: { accountValue: '25' }, withdrawable: '25', assetPositions: [] });
    }
    throw new Error(`unexpected request ${url} ${String(init.body)}`);
  });
  return posted;
}

const sig = (s: HlSignature) => ({ r: s.r, s: s.s, v: BigInt(s.v) });

for (const [apiUrl, source, hyperliquidChain] of [
  ['https://api.hyperliquid.xyz', 'a', 'Mainnet'],
  ['https://api.hyperliquid-testnet.xyz', 'b', 'Testnet'],
] as const) {
  test(`venue signs for the network its API URL points at (${hyperliquidChain})`, async (t) => {
    const posted = stubHyperliquid(t);
    const venue = createHyperliquidVenue({
      info: new HlInfo(apiUrl),
      dex: 'xyz',
      user: account.address,
      trader: {
        account,
        arbitrum: { readContract: async () => 0n } as never,
        arbitrumSender: null as never,
        arbitrumUsdc: zeroAddress,
        bridge: zeroAddress,
      },
    });

    await assert.rejects(venue.open({ symbol: 'AAPL', side: 'long', collateralUsd: 10, leverage: 3, maxSlippageBps: 50 }), /updateLeverage rejected/);
    await assert.rejects(venue.topUpMargin(), /sendAsset rejected/);
    const [lev, send] = posted;
    assert.equal(lev?.action.type, 'updateLeverage');
    assert.equal(send?.action.type, 'sendAsset');

    const l1Signer = await recoverTypedDataAddress({
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: zeroAddress },
      types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      primaryType: 'Agent',
      message: { source, connectionId: actionHash(lev.action, lev.nonce) },
      signature: sig(lev.signature),
    });
    assert.ok(isAddressEqual(l1Signer, account.address), `L1 action not signed with source "${source}"`);

    assert.equal(send.action.hyperliquidChain, hyperliquidChain);
    const userSigner = await recoverTypedDataAddress({
      domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: Number(send.action.signatureChainId), verifyingContract: zeroAddress },
      types: { 'HyperliquidTransaction:SendAsset': SEND_ASSET_FIELDS },
      primaryType: 'HyperliquidTransaction:SendAsset',
      message: send.action,
      signature: sig(send.signature),
    });
    assert.ok(isAddressEqual(userSigner, account.address));
  });
}

/**
 * An xyz AAPL open (growth mode, deployer fee scale 1, like live xyz) whose order fills 0.088 at 340.2 (oid 7).
 * `fills`: what userFillsByTime returns (a Response = that HTTP error); `userFees`: the userFees body, or an error.
 */
function stubFilledOpen(t: TestContext, o: { fills: unknown[] | Response; userFees: unknown | Response }) {
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/exchange')) {
      if (body.action.type === 'order') {
        return json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.088', avgPx: '340.2', oid: 7 } }] } } });
      }
      return json({ status: 'ok', response: { type: 'default' } });
    }
    switch (body.type) {
      case 'perpDexs':
        return json([null, { name: 'xyz' }]);
      case 'metaAndAssetCtxs':
        return json([
          { universe: [{ name: 'xyz:AAPL', szDecimals: 3, maxLeverage: 20, growthMode: 'enabled', deployerFeeScale: '1.0' }], collateralToken: 0 },
          [{ markPx: '340.1', midPx: '340.1', prevDayPx: '336' }],
        ]);
      case 'userFillsByTime':
        return o.fills instanceof Response ? o.fills : json(o.fills);
      case 'userFees':
        return o.userFees instanceof Response ? o.userFees : json(o.userFees);
    }
    throw new Error(`unexpected request ${url} ${String(init.body)}`);
  });
  return createHyperliquidVenue({
    info: new HlInfo('https://api.hyperliquid.xyz'),
    dex: 'xyz',
    user: account.address,
    trader: { account, arbitrum: null as never, arbitrumSender: null as never, arbitrumUsdc: zeroAddress, bridge: zeroAddress },
  });
}

const openAapl = { symbol: 'AAPL', side: 'long', collateralUsd: 10, leverage: 3, maxSlippageBps: 50 } as const;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('a filled open survives a failed fills lookup: the order response becomes the fill, its fee from the fee schedule', async (t) => {
  // A tier with staking discount (3.5 bps) and a 4% referral discount: xyz's 2x HIP-3 scale and 90% growth-mode cut apply on top.
  const venue = stubFilledOpen(t, { fills: new Response('upstream down', { status: 502 }), userFees: { userCrossRate: '0.00035', activeReferralDiscount: '0.04' } });

  const fill = await venue.open(openAapl);

  const notional = 0.088 * 340.2;
  assert.deepEqual(
    { ...fill, sizeUsd: Number(fill.sizeUsd.toFixed(6)), collateralUsedUsd: Number(fill.collateralUsedUsd.toFixed(6)), feeUsd: Number(fill.feeUsd.toFixed(9)) },
    {
      symbol: 'AAPL',
      side: 'long',
      sizeUsd: Number(notional.toFixed(6)),
      price: 340.2,
      feeUsd: Number((notional * 0.00035 * 2 * 0.1 * 0.96).toFixed(9)),
      realizedPnlUsd: 0,
      collateralReleasedUsd: 0,
      collateralUsedUsd: Number((notional / 3).toFixed(6)),
      tx: { chain: 'hyperliquid', hash: 'oid:7' },
    },
  );
});

test('the fee estimate falls back to the base taker rate when the fee tier is unreadable', async (t) => {
  const venue = stubFilledOpen(t, { fills: new Response('down', { status: 502 }), userFees: new Response('down', { status: 502 }) });
  const fill = await venue.open(openAapl);
  assert.ok(close(fill.feeUsd, 0.088 * 340.2 * 0.00045 * 2 * 0.1), `fee ${fill.feeUsd}`);
});

test('fills indexed for only part of the order: venue fees for that part, the schedule for the rest', async (t) => {
  const indexed = { coin: 'xyz:AAPL', px: '340.1', sz: '0.05', side: 'B', time: Date.now(), dir: 'Open Long', closedPnl: '0.0', oid: 7, fee: '0.0017', feeToken: 'USDC' };
  const venue = stubFilledOpen(t, {
    fills: [{ ...indexed, hash: `0x${'0'.repeat(64)}` }],
    userFees: { userCrossRate: '0.00045', activeReferralDiscount: '0.0' },
  });

  const fill = await venue.open(openAapl);

  const restNotional = 0.088 * 340.2 - 0.05 * 340.1;
  assert.ok(close(fill.sizeUsd, 0.088 * 340.2), `size ${fill.sizeUsd}`);
  assert.ok(close(fill.feeUsd, 0.0017 + restNotional * 0.00009), `fee ${fill.feeUsd}`);
  // An all-zero fill hash is no tx reference.
  assert.deepEqual(fill.tx, { chain: 'hyperliquid', hash: 'oid:7' });
});

test('takerFeeRate follows the documented HIP-3 formula and matches live xyz fills (0.9 bps at tier 0)', () => {
  // Live: 0.105 xyz:TSLA at 371.48 paid 0.00351 USDC (the venue rounds fees to 6 decimals) with a tier-0 (4.5 bps) taker rate.
  assert.ok(Math.abs(0.105 * 371.48 * takerFeeRate(0.00045, 0, { deployerFeeScale: 1, growthMode: true }) - 0.00351) < 1e-6);
  assert.ok(close(takerFeeRate(0.00045, 0, { deployerFeeScale: 0.5, growthMode: false }), 0.00045 * 1.5));
  assert.ok(close(takerFeeRate(0.00045, 0, { deployerFeeScale: 2, growthMode: false }), 0.00045 * 4));
});

interface WireOrder {
  b: boolean;
  s: string;
  r: boolean;
}

/**
 * Hyperliquid with an isolated AAPL position of `szi` (none when null) at `leverage`: each order fills
 * `fillSz(requested)` at 340, and its fills are indexed right away.
 */
function stubTrading(t: TestContext, o: { szi: string | null; leverage: number; fillSz?: (sz: string) => string; refuseLeverage?: boolean }) {
  const orders: WireOrder[] = [];
  const fills: { oid: number; sz: string }[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/exchange')) {
      if (body.action.type === 'updateLeverage' && o.refuseLeverage) return json({ status: 'err', response: 'Cannot change leverage with open position.' });
      if (body.action.type !== 'order') return json({ status: 'ok', response: { type: 'default' } });
      const order = body.action.orders[0] as WireOrder;
      orders.push(order);
      const oid = orders.length;
      const totalSz = o.fillSz ? o.fillSz(order.s) : order.s;
      fills.push({ oid, sz: totalSz });
      return json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz, avgPx: '340', oid } }] } } });
    }
    switch (body.type) {
      case 'perpDexs':
        return json([null, { name: 'xyz' }]);
      case 'metaAndAssetCtxs':
        return json([
          { universe: [{ name: 'xyz:AAPL', szDecimals: 3, maxLeverage: 20 }], collateralToken: 0 },
          [{ markPx: '340.1', midPx: '340.1', prevDayPx: '336' }],
        ]);
      case 'clearinghouseState': {
        const held = o.szi === null ? 0 : Math.abs(Number(o.szi));
        const position = {
          coin: 'xyz:AAPL',
          szi: o.szi,
          entryPx: '340',
          positionValue: String(held * 340.1),
          unrealizedPnl: '0',
          marginUsed: String((held * 340) / o.leverage),
          liquidationPx: '200',
          leverage: { type: 'isolated', value: o.leverage },
        };
        return json({ marginSummary: { accountValue: '1000' }, withdrawable: '1000', assetPositions: o.szi === null ? [] : [{ position }] });
      }
      case 'userFillsByTime':
        return json(
          fills.map((f) => ({ coin: 'xyz:AAPL', px: '340', sz: f.sz, side: 'A', time: Date.now(), dir: 'Close Long', closedPnl: '0', hash: `0x${f.oid}`, oid: f.oid, fee: '0.01', feeToken: 'USDC' })),
        );
    }
    throw new Error(`unexpected request ${url} ${String(init.body)}`);
  });
  const venue = createHyperliquidVenue({
    info: new HlInfo('https://api.hyperliquid.xyz'),
    dex: 'xyz',
    user: account.address,
    trader: { account, arbitrum: null as never, arbitrumSender: null as never, arbitrumUsdc: zeroAddress, bridge: zeroAddress },
  });
  return { venue, orders };
}

test('a close that fills only part of the position reports what it closed, not a full close', async (t) => {
  const { venue, orders } = stubTrading(t, { szi: '0.088', leverage: 3, fillSz: () => '0.03' });

  const fill = await venue.reduce('AAPL', 1, 50);

  assert.deepEqual(orders.map((x) => [x.s, x.r, x.b]), [['0.088', true, false]]);
  assert.equal(fill.complete, false);
  assert.ok(Math.abs(fill.closedFraction - 0.03 / 0.088) < 1e-12);
  assert.ok(Math.abs(fill.collateralReleasedUsd - (0.088 * 340) / 3 * (0.03 / 0.088)) < 1e-9);
});

test('a fully filled close reports the whole position closed', async (t) => {
  const { venue } = stubTrading(t, { szi: '0.088', leverage: 3 });
  const fill = await venue.reduce('AAPL', 1, 50);
  assert.deepEqual([fill.closedFraction, fill.complete], [1, true]);
});

test("a partial reduce under Hyperliquid's $10 minimum closes the whole position instead of being rejected", async (t) => {
  // 25% of 0.088 AAPL is ~$7.50: below MinTradeNtl. Only an exact reduce-only close is exempt.
  const { venue, orders } = stubTrading(t, { szi: '0.088', leverage: 3 });
  const fill = await venue.reduce('AAPL', 0.25, 50);
  assert.deepEqual(orders.map((x) => x.s), ['0.088']);
  assert.deepEqual([fill.closedFraction, fill.complete], [1, true]);
});

test('a partial reduce at or above the minimum reduces only the requested fraction', async (t) => {
  const { venue, orders } = stubTrading(t, { szi: '-0.2', leverage: 3 });
  const fill = await venue.reduce('AAPL', 0.25, 50);
  assert.deepEqual(orders.map((x) => [x.s, x.b]), [['0.05', true]]);
  assert.deepEqual([fill.closedFraction, fill.complete], [0.25, true]);
});

test('an add under a refused leverage change is sized at the open position’s leverage', async (t) => {
  const { venue, orders } = stubTrading(t, { szi: '0.05', leverage: 2, refuseLeverage: true });
  const fill = await venue.open({ symbol: 'AAPL', side: 'long', collateralUsd: 20, leverage: 5, maxSlippageBps: 50 });
  // $20 at the position's 2x, not the requested 5x (which would margin $50).
  assert.deepEqual(orders.map((x) => x.s), ['0.117']);
  assert.ok(Math.abs(fill.collateralUsedUsd - (0.117 * 340) / 2) < 1e-9);
});

test('an add is refused when the open position runs at a higher leverage than requested', async (t) => {
  const { venue, orders } = stubTrading(t, { szi: '0.05', leverage: 10, refuseLeverage: true });
  await assert.rejects(venue.open({ symbol: 'AAPL', side: 'long', collateralUsd: 20, leverage: 5, maxSlippageBps: 50 }), /10x/);
  assert.equal(orders.length, 0);
});

test('a partially filled open reports the margin that filled', async (t) => {
  const { venue } = stubTrading(t, { szi: null, leverage: 5, fillSz: () => '0.1' });
  const fill = await venue.open({ symbol: 'AAPL', side: 'long', collateralUsd: 20, leverage: 5, maxSlippageBps: 50 });
  assert.ok(Math.abs(fill.collateralUsedUsd - (0.1 * 340) / 5) < 1e-9);
});

test('a Bridge2 deposit not credited in time is reported uncredited, then found credited by its Arbitrum tx hash', async (t) => {
  const deposit = { chain: 'arbitrum' as const, hash: `0x${'ab'.repeat(32)}` };
  let credited = false;
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    switch (body.type) {
      case 'clearinghouseState':
        return json({ marginSummary: { accountValue: '0' }, withdrawable: '0', assetPositions: [] });
      case 'userNonFundingLedgerUpdates':
        // Hyperliquid books the deposit under the Arbitrum transfer's hash (checksummed case differs).
        return json([
          { time: 1, hash: `0x${'cd'.repeat(32)}`, delta: { type: 'deposit', usdc: '12.34' } },
          ...(credited ? [{ time: 2, hash: deposit.hash.toUpperCase().replace('0X', '0x'), delta: { type: 'deposit', usdc: '12.34' } }] : []),
        ]);
    }
    throw new Error(`unexpected request ${String(init.body)}`);
  });
  const venue = createHyperliquidVenue({
    info: new HlInfo('https://api.hyperliquid.xyz'),
    dex: 'xyz',
    user: account.address,
    trader: {
      account,
      arbitrum: { readContract: async () => 12_340_000n, getCode: async () => '0x60' } as never,
      arbitrumSender: { exclusive: async (fn: (send: unknown) => unknown) => fn(async () => ({ ref: deposit })) } as never,
      arbitrumUsdc: zeroAddress,
      bridge: zeroAddress,
    },
    creditWait: { pollMs: 1, timeoutMs: 20 },
  });

  assert.deepEqual(await venue.topUpMargin(), { movedUsd: 0, txs: [deposit], uncredited: { usd: 12.34, tx: deposit } });
  assert.equal(await venue.depositCredited!(deposit, 0), false);
  credited = true;
  assert.equal(await venue.depositCredited!(deposit, 0), true);
});
