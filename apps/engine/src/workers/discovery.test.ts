import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kvGet } from '../db.ts';
import { address, createTestEngine, okVerify, seedToken } from '../testing/fakes.ts';
import { runDiscovery } from './discovery.ts';

const A = address(0xa);

test('a token registered through the API while discovery verifies it counts as skipped, and the cursor advances', async () => {
  const t = createTestEngine();
  t.world.io.discovery.scan = async () => ({ candidates: [{ token: A, launchpad: 'pons' }], toBlock: 100n });
  t.world.io.launchpads.pons.verify = async () => {
    seedToken(t.engine, { address: A }); // the creator's POST /api/tokens wins the insert
    return okVerify(t.world.deployer);
  };

  const summary = await runDiscovery(t.engine);

  assert.match(summary, /0 registered, 1 skipped/);
  assert.equal(kvGet<string>(t.engine.db, 'discovery.cursor'), '101');
});
