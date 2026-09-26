/**
 * Vectors from the official Python SDK test suite:
 * https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/tests/signing_test.py
 * (the Python SDK prints r/s without leading zeros, so compare as integers).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { floatToWire } from './format.ts';
import { actionHash, signL1Action, signUserSignedAction } from './signing.ts';

const wallet = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123');

function orderAction(asset: number, isBuy: boolean, px: number, sz: number, tif: 'Ioc' | 'Gtc') {
  return {
    type: 'order',
    orders: [{ a: asset, b: isBuy, p: floatToWire(px), s: floatToWire(sz), r: false, t: { limit: { tif } } }],
    grouping: 'na',
  };
}

test('phantom agent connectionId matches production (test_phantom_agent_creation_matches_production)', () => {
  const action = orderAction(4, true, 1670.1, 0.0147, 'Ioc');
  assert.equal(actionHash(action, 1677777606040), '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
});

test('L1 action signature matches (test_l1_action_signing_matches)', async () => {
  const action = { type: 'dummy', num: 100_000_000_000 }; // float_to_int_for_hashing(1000)
  const mainnet = await signL1Action(wallet, action, 0, true);
  assert.equal(BigInt(mainnet.r), 0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298n);
  assert.equal(BigInt(mainnet.s), 0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8n);
  assert.equal(mainnet.v, 27);
  const testnet = await signL1Action(wallet, action, 0, false);
  assert.equal(BigInt(testnet.r), 0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510n);
  assert.equal(testnet.v, 28);
});

test('order signature matches (test_l1_action_signing_order_matches)', async () => {
  const sig = await signL1Action(wallet, orderAction(1, true, 100, 100, 'Gtc'), 0, true);
  assert.equal(BigInt(sig.r), 0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78en);
  assert.equal(BigInt(sig.s), 0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940en);
  assert.equal(sig.v, 28);
});

test('user-signed action matches (test_sign_usd_transfer_action)', async () => {
  const sig = await signUserSignedAction(
    wallet,
    {
      signatureChainId: '0x66eee',
      hyperliquidChain: 'Testnet',
      destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a',
      amount: '1',
      time: 1687816341423,
    },
    'HyperliquidTransaction:UsdSend',
    [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  );
  assert.equal(BigInt(sig.r), 0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073n);
  assert.equal(BigInt(sig.s), 0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7n);
  assert.equal(sig.v, 27);
});
