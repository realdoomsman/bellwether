import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { isAddressEqual, recoverTypedDataAddress, zeroAddress } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { HlInfo } from './info.ts';
import { actionHash, SEND_ASSET_FIELDS } from './signing.ts';
import type { HlSignature } from './signing.ts';
import { createHyperliquidVenue } from './venue.ts';

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

test('a filled open survives a failed fills lookup: the order response becomes the fill', async (t) => {
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
          { universe: [{ name: 'xyz:AAPL', szDecimals: 3, maxLeverage: 20 }], collateralToken: 0 },
          [{ markPx: '340.1', midPx: '340.1', prevDayPx: '336' }],
        ]);
      case 'userFillsByTime':
        return new Response('upstream down', { status: 502 });
    }
    throw new Error(`unexpected request ${url} ${String(init.body)}`);
  });
  const venue = createHyperliquidVenue({
    info: new HlInfo('https://api.hyperliquid.xyz'),
    dex: 'xyz',
    user: account.address,
    trader: { account, arbitrum: null as never, arbitrumSender: null as never, arbitrumUsdc: zeroAddress, bridge: zeroAddress },
  });

  const fill = await venue.open({ symbol: 'AAPL', side: 'long', collateralUsd: 10, leverage: 3, maxSlippageBps: 50 });

  assert.deepEqual(
    { ...fill, sizeUsd: Number(fill.sizeUsd.toFixed(6)) },
    {
      symbol: 'AAPL',
      side: 'long',
      sizeUsd: Number((0.088 * 340.2).toFixed(6)),
      price: 340.2,
      feeUsd: 0,
      realizedPnlUsd: 0,
      collateralReleasedUsd: 0,
      tx: { chain: 'hyperliquid', hash: 'oid:7' },
    },
  );
});
