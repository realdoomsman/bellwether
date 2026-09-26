import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicErrorText, registerSecretUrl, scrubString } from './log.ts';

test('URLs carrying credentials are redacted down to their host; plain URLs are kept', () => {
  const cases: [string, string][] = [
    ['RPC https://rhc.g.alchemy.com/v2/AbCdEf0123456789AbCdEf0123 down', 'RPC https://rhc.g.alchemy.com/[redacted] down'],
    ['GET https://x.quiknode.pro/0123456789abcdef0123456789abcdef01234567/ failed', 'GET https://x.quiknode.pro/[redacted] failed'],
    ['call https://rpc.example.org/?apikey=short1 failed', 'call https://rpc.example.org/[redacted] failed'],
    ['call https://user:pw@rpc.example.org/ failed', 'call https://rpc.example.org/[redacted] failed'],
    ['see https://robinhoodchain.blockscout.com/tx/0xabc', 'see https://robinhoodchain.blockscout.com/tx/0xabc'],
  ];
  for (const [input, expected] of cases) assert.equal(scrubString(input), expected);
});

test('a registered private endpoint is redacted even when it appears without its scheme', () => {
  registerSecretUrl('https://rhc.private-node.io/rpc/Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2');
  assert.equal(scrubString('POST rhc.private-node.io/rpc/Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2 timed out'), 'POST rhc.private-node.io[redacted] timed out');
});

test('public error text keeps only the first line (viem appends URL/body meta lines) and is bounded', () => {
  assert.equal(publicErrorText('HTTP request failed.\n\nURL: https://a.io/k\nRequest body: {}'), 'HTTP request failed.');
  assert.equal(publicErrorText('x'.repeat(1000)).length, 300);
});
