import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listActivity } from '../activity.ts';
import { burnTotals } from '../positions.ts';
import { address, createTestEngine, seedToken } from '../testing/fakes.ts';
import { runClaimer } from './claimer.ts';

const A = address(0xa);

test('a claim that pays no ETH but burns token fees still records the burn', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  t.world.claimable.set(A, 10n ** 16n);
  const burnTx = { chain: 'rhc' as const, hash: `0x${'b'.repeat(64)}` };
  // Someone else collected the ETH between preview and send; the launchpad still burned the token-side fees.
  t.world.io.launchpads.pons.claim = async () => ({ amountWei: 0n, tx: { chain: 'rhc', hash: `0x${'c'.repeat(64)}` }, tokensBurned: { amount: 5n * 10n ** 18n, tx: burnTx } });

  await runClaimer(t.engine);

  assert.equal(burnTotals(t.engine.db).byTarget.get(A), 5n * 10n ** 18n);
  assert.equal(t.engine.ledger.book(A).fees_eth, 0);
  const [claim] = listActivity(t.engine.db, { limit: 5, token: A }).filter((e) => e.kind === 'claim');
  assert.equal(claim?.tokensBurned, 5);
});

test('an escrow holding only memecoin is claimed and burned; the ETH minimum gates only the ETH leg', async () => {
  const t = createTestEngine();
  seedToken(t.engine, { address: A });
  const pons = t.world.io.launchpads.pons;
  let preview = { wei: 0n, tokens: 7n * 10n ** 18n };
  let claims = 0;
  pons.claimablePreview = async () => preview;
  pons.claimable = async () => preview.wei;
  pons.claim = async () => {
    claims++;
    return { amountWei: preview.wei, tx: { chain: 'rhc', hash: `0x${String(claims).repeat(64)}` }, tokensBurned: { amount: preview.tokens, tx: { chain: 'rhc', hash: `0x${'d'.repeat(63)}${claims}` } } };
  };

  await runClaimer(t.engine);
  assert.equal(claims, 1, 'token-only claim runs');
  assert.equal(burnTotals(t.engine.db).byTarget.get(A), 7n * 10n ** 18n);

  // Dust ETH below claimMinEth and no memecoin: skipped, as before.
  preview = { wei: 1n, tokens: 0n };
  await runClaimer(t.engine);
  assert.equal(claims, 1, 'ETH below the minimum alone does not claim');

  // Dust ETH plus memecoin: the memecoin leg alone justifies the claim.
  preview = { wei: 1n, tokens: 2n * 10n ** 18n };
  await runClaimer(t.engine);
  assert.equal(claims, 2);
});
