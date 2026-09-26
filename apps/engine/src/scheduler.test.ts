import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from './db.ts';
import { Scheduler, type WorkerDef } from './scheduler.ts';

const INTERVAL = 45_000;
const JITTER = 1.1;

function failing(id: WorkerDef['id'], maxBackoffFactor?: number): WorkerDef {
  return {
    id,
    label: id,
    intervalMs: INTERVAL,
    exclusive: false,
    ...(maxBackoffFactor ? { maxBackoffFactor } : {}),
    run: async () => {
      throw new Error('venue unreachable');
    },
  };
}

test('a failing risk loop backs off at most its cap while other workers back off further', async () => {
  const now = 1_000_000;
  const scheduler = new Scheduler(openDb(':memory:'), [failing('guardian', 2), failing('claimer')], () => now);
  scheduler.start();
  try {
    for (let i = 0; i < 4; i++) {
      await scheduler.runNow('guardian');
      await scheduler.runNow('claimer');
    }
    const next = Object.fromEntries(scheduler.health().map((h) => [h.id, h.nextRunAt! - now]));
    assert.ok(next.guardian! <= 2 * INTERVAL * JITTER, `guardian next run in ${next.guardian}ms`);
    assert.ok(next.claimer! >= 8 * INTERVAL / JITTER, `claimer next run in ${next.claimer}ms`);
  } finally {
    await scheduler.stop();
  }
});
