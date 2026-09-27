import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent, WorkerHealth } from '@bellwether/shared';
import { Alerter } from './alerts.ts';
import { EventBus } from './bus.ts';

function setup() {
  const sent: string[] = [];
  const now = { t: 0 };
  const alerter = new Alerter([async (text) => void sent.push(text)], 'live', () => now.t);
  return { sent, now, alerter };
}

const health = (consecutiveErrors: number): WorkerHealth => ({
  id: 'buyback',
  label: 'Buyback & burn',
  lastRunAt: 0,
  lastOkAt: null,
  lastError: 'swap reverted',
  consecutiveErrors,
  nextRunAt: null,
  running: false,
});

const activity = (kind: ActivityEvent['kind'], title: string): ActivityEvent => ({
  id: '1',
  kind,
  at: 0,
  token: null,
  tokenSymbol: null,
  title,
  txs: [{ chain: 'rhc', hash: '0xabc', url: 'https://explorer/tx/0xabc' }],
});

test('pages on a failure streak, repeats while it lasts, and reports recovery', async () => {
  const { sent, alerter } = setup();
  for (let n = 1; n <= 24; n++) alerter.workerFinished(health(n), false, n - 1);
  alerter.workerFinished(health(0), true, 24);
  alerter.workerFinished(health(0), true, 1);
  await alerter.flush();
  assert.deepEqual(sent, [
    '[Bellwether] 🔴 Buyback & burn has failed 3 runs in a row: swap reverted',
    '[Bellwether] 🔴 Buyback & burn has failed 23 runs in a row: swap reverted',
    '[Bellwether] ✅ Buyback & burn recovered after 24 failed runs.',
  ]);
});

test('forwards only risk-class activity, with explorer links', async () => {
  const { sent, alerter } = setup();
  const bus = new EventBus();
  alerter.watch(bus);
  bus.emit({ type: 'activity', data: activity('claim', 'Claimed 0.1 ETH') });
  bus.emit({ type: 'activity', data: activity('stop', 'Stopped out of AAPL at -30%') });
  bus.emit({ type: 'activity', data: activity('kill-switch', 'Kill switch on') });
  await alerter.flush();
  assert.deepEqual(sent, ['[Bellwether] ⚠️ Stopped out of AAPL at -30%\nhttps://explorer/tx/0xabc', '[Bellwether] 🛑 Kill switch on\nhttps://explorer/tx/0xabc']);
});

test('rate limits a burst and reports how many were suppressed', async () => {
  const { sent, now, alerter } = setup();
  for (let i = 0; i < 20; i++) alerter.notify(`a${i}`);
  await alerter.flush();
  assert.equal(sent.length, 12);
  now.t = 61_000;
  alerter.notify('later');
  await alerter.flush();
  assert.equal(sent.at(-1), '[Bellwether] later\n(8 earlier alerts suppressed by rate limit; see logs)');
});

test('a failing sink never throws into the engine and later alerts still go out', async () => {
  let calls = 0;
  const alerter = new Alerter(
    [
      async () => {
        calls++;
        if (calls === 1) throw new Error('HTTP 500');
      },
    ],
    'paper',
  );
  alerter.notify('first');
  alerter.notify('second');
  await alerter.flush();
  assert.equal(calls, 2);
});
