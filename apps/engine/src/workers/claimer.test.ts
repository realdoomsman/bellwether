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
