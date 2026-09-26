import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexMentionsAddress, topicAddress } from './hex.ts';

const WALLET = '0x2cdE129778a416279d9f6F1E9B5c3abb302D1CD7';
const word = (addr: string) => addr.slice(2).toLowerCase().padStart(64, '0');

test('finds the wallet ABI-encoded as a parameter in calldata, log data and topics', () => {
  const calldata = `0x686399cb${'0'.repeat(63)}1${word(WALLET)}`;
  assert.equal(hexMentionsAddress(calldata, WALLET), true);
  assert.equal(hexMentionsAddress(calldata.toUpperCase().replace('0X', '0x'), WALLET), true);
  assert.equal(hexMentionsAddress(`0x${word(WALLET)}`, WALLET), true);
});

test('ignores other addresses, unpadded byte coincidences and empty blobs', () => {
  assert.equal(hexMentionsAddress(`0x686399cb${word('0x000000000000000000000000000000000000dEaD')}`, WALLET), false);
  // Packed encoding: the address bytes appear but not as a left-padded 32-byte word.
  assert.equal(hexMentionsAddress(`0x${'ff'.repeat(12)}${WALLET.slice(2)}`, WALLET), false);
  assert.equal(hexMentionsAddress('0x', WALLET), false);
  assert.equal(hexMentionsAddress(null, WALLET), false);
});

test('topicAddress accepts only non-zero address-shaped topics', () => {
  assert.equal(topicAddress(`0x${word(WALLET)}`), WALLET.toLowerCase());
  assert.equal(topicAddress(`0x${'0'.repeat(64)}`), null);
  assert.equal(topicAddress('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff27660'), null);
});
