import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenBucket } from './ratelimit.ts';

test('the bucket map stays bounded under key churn and evicts the least recently used key', () => {
  const bucket = new TokenBucket(2, 1, () => 0, 100);
  assert.equal(bucket.take('regular'), true);
  assert.equal(bucket.take('regular'), true);
  for (let i = 0; i < 99; i++) bucket.take(`spoofed-${i}`);
  // Touching "regular" keeps it recent, so the churn evicts the oldest spoofed keys instead.
  assert.equal(bucket.take('regular'), false);
  for (let i = 99; i < 10_000; i++) bucket.take(`spoofed-${i}`);
  assert.equal(bucket.size, 100);
});
