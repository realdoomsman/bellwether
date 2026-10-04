import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listActivity } from '../activity.ts';
import { kvGet } from '../db.ts';
import { getToken } from '../tokens.ts';
import { address, createTestEngine, okVerify, seedToken } from '../testing/fakes.ts';
import { DISCOVERY_GIVE_UP_AFTER_MS, DISCOVERY_MAX_ATTEMPTS, runDiscovery } from './discovery.ts';

const A = address(0xa);
const B = address(0xb);

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

test('a candidate that never resolves holds the cursor only until it is given up on, then is surfaced', async () => {
  const t = createTestEngine();
  let toBlock = 100n;
  t.world.io.discovery.scan = async () => ({ candidates: [{ token: A, launchpad: 'pons' }], toBlock });
  t.world.io.launchpads.pons.verify = async () => ({ ok: false, failure: 'lookup-failed', detail: 'launch tx not found', deployer: null, metadata: null });
  const step = Math.ceil(DISCOVERY_GIVE_UP_AFTER_MS / (DISCOVERY_MAX_ATTEMPTS - 1));

  for (let i = 1; i < DISCOVERY_MAX_ATTEMPTS; i++) {
    await assert.rejects(runDiscovery(t.engine), /1 lookups failed .*launch tx not found/);
    assert.equal(kvGet<string>(t.engine.db, 'discovery.cursor'), null, `run ${i} keeps the cursor`);
    t.now.t += step;
  }
  const summary = await runDiscovery(t.engine);
  assert.match(summary, /1 given up/);
  assert.equal(kvGet<string>(t.engine.db, 'discovery.cursor'), '101');
  assert.ok(listActivity(t.engine.db, { limit: 50 }).some((e) => e.kind === 'risk' && e.title.includes(`gave up on ${A}`)));

  // Later scans move on; the abandoned range is not retried.
  toBlock = 200n;
  t.world.io.discovery.scan = async () => ({ candidates: [], toBlock });
  await runDiscovery(t.engine);
  assert.equal(kvGet<string>(t.engine.db, 'discovery.cursor'), '201');
});

test('many quick failures (an outage) never give a candidate up before the time bound', async () => {
  const t = createTestEngine();
  t.world.io.discovery.scan = async () => ({ candidates: [{ token: A, launchpad: 'pons' }], toBlock: 100n });
  let down = true;
  t.world.io.launchpads.pons.verify = async () => {
    if (down) throw new Error('rpc timeout');
    return okVerify(t.world.deployer);
  };
  for (let i = 0; i < DISCOVERY_MAX_ATTEMPTS * 3; i++) {
    await assert.rejects(runDiscovery(t.engine), /rpc timeout/);
    t.now.t += 60_000;
  }
  assert.equal(kvGet<string>(t.engine.db, 'discovery.cursor'), null);
  down = false;
  assert.match(await runDiscovery(t.engine), /1 registered/);
  assert.equal(kvGet<string>(t.engine.db, 'discovery.cursor'), '101');
  assert.ok(getToken(t.engine.db, A));
});

test('a given-up candidate is not looked up again while a newer failure still holds the cursor', async () => {
  const t = createTestEngine();
  const candidates = [{ token: A, launchpad: 'pons' as const }];
  t.world.io.discovery.scan = async () => ({ candidates: [...candidates], toBlock: 100n });
  const lookups: Record<string, number> = { [A]: 0, [B]: 0 };
  t.world.io.launchpads.pons.verify = async (token) => {
    lookups[token]!++;
    return { ok: false, failure: 'lookup-failed', detail: 'nope', deployer: null, metadata: null };
  };
  for (let i = 1; i < DISCOVERY_MAX_ATTEMPTS; i++) {
    await assert.rejects(runDiscovery(t.engine));
    t.now.t += DISCOVERY_GIVE_UP_AFTER_MS;
  }
  // A is given up on in the same run that B, a newer launch in the scanned range, first fails.
  candidates.push({ token: B, launchpad: 'pons' });
  await assert.rejects(runDiscovery(t.engine), /1 given up; 1 lookups failed/);
  assert.equal(kvGet<string>(t.engine.db, 'discovery.cursor'), null);
  await assert.rejects(runDiscovery(t.engine), /1 lookups failed/);
  assert.deepEqual(lookups, { [A]: DISCOVERY_MAX_ATTEMPTS, [B]: 2 });
});
