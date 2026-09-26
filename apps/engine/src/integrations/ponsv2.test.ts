import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, zeroAddress } from 'viem';
import { claimTag, PONS_V2_ESCROW_ABI, ponsV2PoolKey, taggedClaimData } from './ponsv2.ts';

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
