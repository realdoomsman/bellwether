import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { HttpRequestError } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ApiError, RegisterResponse, SettingsChallenge, StatusResponse, TokenSummary, VerifyResponse } from '@stepup/shared';
import { activity } from '../engine.ts';
import { Scheduler } from '../scheduler.ts';
import { address, createTestEngine, okVerify } from '../testing/fakes.ts';
import { getToken } from '../tokens.ts';
import { workerDefs } from '../workers/index.ts';
import { createApp } from './app.ts';
import { MAX_STREAMS_PER_IP } from './stream.ts';

const TOKEN = address(0x7070);
const ADMIN = 'admin-token-for-tests-0123456789';

function setup(env: Record<string, string> = {}) {
  const t = createTestEngine(env);
  const { app } = createApp(t.engine, new Scheduler(t.engine.db, workerDefs(t.engine), t.engine.clock));
  const call = async <T>(path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const res = await app.request(path, json === undefined ? rest : { ...rest, method: rest.method ?? 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json', ...rest.headers } });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { ...t, app, call };
}

const registration = { address: TOKEN, launchpad: 'pons', market: 'AAPL', side: 'long', strategy: 'balanced', maxLeverage: 5 };

test('register validates input with stable error codes', async () => {
  const { call } = setup();
  const cases: [Record<string, unknown>, number, string][] = [
    [{ ...registration, address: '0x123' }, 400, 'invalid_address'],
    [{ ...registration, launchpad: 'pumpfun' }, 400, 'unsupported_launchpad'],
    [{ ...registration, market: 'DOGE' }, 400, 'unsupported_market'],
    [{ ...registration, market: 'NVDA' }, 400, 'unsupported_market'],
    [{ ...registration, strategy: 'yolo' }, 400, 'invalid_strategy'],
    [{ ...registration, side: 'short' }, 400, 'short_unavailable'],
    [{ ...registration, maxLeverage: 11 }, 400, 'invalid_leverage'],
    [{ ...registration, maxLeverage: 2 }, 400, 'invalid_leverage'],
  ];
  for (const [body, status, code] of cases) {
    const res = await call<ApiError>('/api/tokens', { json: body });
    assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(body));
  }
  const lev = await call<ApiError>('/api/tokens', { json: { ...registration, maxLeverage: 11 } });
  assert.deepEqual(lev.body.details, { min: 3, max: 10 });
});

test('a strategy whose minimum leverage the market cannot reach is refused, not offered an inverted range', async () => {
  const { call, world } = setup();
  world.markets = world.markets.map((m) => (m.symbol === 'TSLA' ? { ...m, maxLeverage: 3 } : m));
  const res = await call<ApiError>('/api/tokens', { json: { ...registration, market: 'TSLA', strategy: 'degen', maxLeverage: 3 } });
  assert.deepEqual([res.status, res.body.code, res.body.details], [400, 'leverage_unavailable', { min: 5, max: 3 }]);
  const steady = await call<RegisterResponse>('/api/tokens', { json: { ...registration, market: 'TSLA', strategy: 'steady', maxLeverage: 3 } });
  assert.equal(steady.status, 201);
});

test('register rejects tokens that fail on-chain checks or impersonate the protocol token', async () => {
  const { call, world } = setup();
  world.verify.set(TOKEN, { ok: false, failure: 'fee-recipient-mismatch', detail: 'Creator wallet is 0xabc', deployer: world.deployer, metadata: null });
  const notOurs = await call<ApiError>('/api/tokens', { json: registration });
  assert.deepEqual([notOurs.status, notOurs.body.code], [422, 'not_protocol_creator']);

  world.verify.set(TOKEN, okVerify(world.deployer, { name: 'Stepup Protocol', symbol: '$ST3P' }));
  const fake = await call<ApiError>('/api/tokens', { json: registration });
  assert.deepEqual([fake.status, fake.body.code], [422, 'impersonation']);

  // Cyrillic look-alikes: С Т Е Р and the е in "Stеpup" are not Latin letters.
  for (const meta of [{ name: 'Totally different', symbol: '$СТЕР' }, { name: 'Stеpup', symbol: 'OTHER' }]) {
    world.verify.set(TOKEN, okVerify(world.deployer, meta));
    const res = await call<ApiError>('/api/tokens', { json: registration });
    assert.deepEqual([res.status, res.body.code], [422, 'impersonation'], meta.name);
  }
});

test('register activates immediately with auto-approve, logs it, and refuses duplicates', async () => {
  const { call } = setup();
  const res = await call<RegisterResponse>('/api/tokens', { json: registration });
  assert.equal(res.status, 201);
  assert.equal(res.body.activated, true);
  assert.equal(res.body.token.status, 'active');
  const events = await call<{ events: { kind: string }[] }>(`/api/activity?token=${TOKEN}`);
  assert.deepEqual(events.body.events.map((e) => e.kind).sort(), ['activated', 'registered']);

  const dup = await call<ApiError>('/api/tokens', { json: registration });
  assert.deepEqual([dup.status, dup.body.code], [409, 'already_registered']);
});

test('without auto-approve a registration waits for review', async () => {
  const { call } = setup({ AUTO_APPROVE: 'false' });
  const res = await call<RegisterResponse>('/api/tokens', { json: registration });
  assert.equal(res.body.activated, false);
  assert.equal(res.body.token.status, 'pending');
  assert.equal(res.body.token.decision.verdict, 'pending-review');
});

test('without a protocol wallet, verify and register are refused and status hides the address', async () => {
  const { call } = setup({ PROTOCOL_ADDRESS: '' });
  const verify = await call<ApiError>(`/api/tokens/${TOKEN}/verify?launchpad=pons`);
  assert.deepEqual([verify.status, verify.body.code], [503, 'wallet_not_configured']);
  const reg = await call<ApiError>('/api/tokens', { json: registration });
  assert.deepEqual([reg.status, reg.body.code], [503, 'wallet_not_configured']);
  const cfg = await call<{ protocolWallet: string | null }>('/api/config');
  assert.equal(cfg.body.protocolWallet, null);
});

test('verify reports each check without registering', async () => {
  const { call, world, engine } = setup();
  world.verify.set(TOKEN, { ok: false, failure: 'wrong-launchpad', detail: 'Deployed by another factory', deployer: null, metadata: null });
  const bad = await call<VerifyResponse>(`/api/tokens/${TOKEN}/verify?launchpad=pons`);
  assert.equal(bad.status, 200);
  assert.equal(bad.body.ok, false);
  assert.deepEqual(
    bad.body.checks.map((c) => [c.id, c.ok]),
    [
      ['contract', true],
      ['launchpad', false],
      ['fee-recipient', false],
      ['impersonation', false],
      ['not-registered', true],
    ],
  );

  world.verify.delete(TOKEN);
  const good = await call<VerifyResponse>(`/api/tokens/${TOKEN}/verify?launchpad=pons`);
  assert.equal(good.body.ok, true);
  assert.equal(good.body.token?.symbol, 'TEST');
  assert.equal(getToken(engine.db, TOKEN), null);
});

async function registerWithDeployer(s: ReturnType<typeof setup>) {
  const deployer = privateKeyToAccount(generatePrivateKey());
  s.world.verify.set(TOKEN, okVerify(deployer.address));
  await s.call('/api/tokens', { json: registration });
  return deployer;
}

const change = { strategy: 'degen', market: 'aapl', side: 'long', maxLeverage: 10 };

test('settings: the challenge spells out the site, token and exact settings; only the deployer can apply it, once', async () => {
  const s = setup({ PUBLIC_URL: 'https://stepup.example' });
  const deployer = await registerWithDeployer(s);

  const challenge = await s.call<SettingsChallenge>(`/api/tokens/${TOKEN}/settings/challenge`, { json: change });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.deployer, deployer.address);
  assert.deepEqual(challenge.body.change, { ...change, market: 'AAPL' });
  const msg = challenge.body.message;
  assert.match(msg, /^Stepup settings change\n/);
  for (const line of [
    'Site: https://stepup.example',
    'Chain: Robinhood Chain (4663)',
    `Token: $TEST ${TOKEN}`,
    'Strategy: Degen (degen)',
    'Market: AAPL',
    'Side: long',
    'Max leverage: 10x',
    `Expires: ${new Date(challenge.body.expiresAt).toISOString()}`,
  ]) {
    assert.ok(msg.split('\n').includes(line), `missing "${line}" in:\n${msg}`);
  }
  assert.match(msg, /^Nonce: [0-9a-f]{32}$/m);

  const stranger = privateKeyToAccount(generatePrivateKey());
  const forged = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings`, {
    json: { nonce: challenge.body.nonce, signature: await stranger.signMessage({ message: msg }) },
  });
  assert.deepEqual([forged.status, forged.body.code], [403, 'bad_signature']);

  const signature = await deployer.signMessage({ message: msg });
  const ok = await s.call<TokenSummary>(`/api/tokens/${TOKEN}/settings`, { json: { nonce: challenge.body.nonce, signature } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.strategy, ok.body.maxLeverage], ['degen', 10]);

  const replay = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings`, { json: { nonce: challenge.body.nonce, signature } });
  assert.deepEqual([replay.status, replay.body.code], [400, 'invalid_nonce']);
  assert.equal(getToken(s.engine.db, TOKEN)!.strategy, 'degen');
});

test('settings: a signature over one set of settings cannot apply different ones', async () => {
  const s = setup();
  const deployer = await registerWithDeployer(s);

  // The deployer signs a harmless change (e.g. on a look-alike site that requested it)...
  const harmless = await s.call<SettingsChallenge>(`/api/tokens/${TOKEN}/settings/challenge`, { json: { ...change, strategy: 'steady', maxLeverage: 3 } });
  const signature = await deployer.signMessage({ message: harmless.body.message });
  // ...and the attacker tries to redeem it for degen at 10x, by body fields or with a fresh challenge.
  const bodyFields = await s.call<TokenSummary>(`/api/tokens/${TOKEN}/settings`, { json: { nonce: harmless.body.nonce, signature, ...change } });
  assert.deepEqual([bodyFields.status, bodyFields.body.strategy, bodyFields.body.maxLeverage], [200, 'steady', 3]);

  const risky = await s.call<SettingsChallenge>(`/api/tokens/${TOKEN}/settings/challenge`, { json: change });
  const swapped = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings`, { json: { nonce: risky.body.nonce, signature } });
  assert.deepEqual([swapped.status, swapped.body.code], [403, 'bad_signature']);
  assert.equal(getToken(s.engine.db, TOKEN)!.strategy, 'steady');
});

test('settings: issuing challenges stores nothing, nobody can void one, and tampered tickets are rejected', async () => {
  const s = setup();
  const deployer = await registerWithDeployer(s);
  const rows = () => s.engine.db.get<{ n: number }>('SELECT count(*) AS n FROM settings_challenges')!.n;
  const mine = await s.call<SettingsChallenge>(`/api/tokens/${TOKEN}/settings/challenge`, { json: change });
  // A third party hammering the endpoint neither grows storage nor supersedes the deployer's challenge.
  for (let i = 0; i < 5; i++) await s.call(`/api/tokens/${TOKEN}/settings/challenge`, { json: { ...change, strategy: 'steady', maxLeverage: 3 } });
  assert.equal(rows(), 0);

  const signature = await deployer.signMessage({ message: mine.body.message });
  const [payload, mac] = mine.body.nonce.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), change: { ...change, strategy: 'steady', maxLeverage: 3 } }),
  ).toString('base64url');
  const tampered = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings`, { json: { nonce: `${forgedPayload}.${mac}`, signature } });
  assert.deepEqual([tampered.status, tampered.body.code], [400, 'invalid_nonce']);

  const ok = await s.call<TokenSummary>(`/api/tokens/${TOKEN}/settings`, { json: { nonce: mine.body.nonce, signature } });
  assert.deepEqual([ok.status, ok.body.strategy], [200, 'degen']);
  assert.equal(rows(), 1, 'only the redeemed id is recorded');

  s.now.t += 10 * 60_000 + 1;
  const next = await s.call<SettingsChallenge>(`/api/tokens/${TOKEN}/settings/challenge`, { json: change });
  await s.call(`/api/tokens/${TOKEN}/settings`, { json: { nonce: next.body.nonce, signature: await deployer.signMessage({ message: next.body.message }) } });
  assert.equal(rows(), 1, 'expired redemption records are purged');
});

test('settings challenges expire after 10 minutes', async () => {
  const s = setup();
  const deployer = await registerWithDeployer(s);
  const challenge = await s.call<SettingsChallenge>(`/api/tokens/${TOKEN}/settings/challenge`, { json: change });
  s.now.t += 10 * 60_000 + 1;
  const res = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings`, {
    json: { nonce: challenge.body.nonce, signature: await deployer.signMessage({ message: challenge.body.message }) },
  });
  assert.deepEqual([res.status, res.body.code], [400, 'nonce_expired']);
});

test('settings challenges validate the complete change like registration does', async () => {
  const s = setup();
  // Venue markets are cached, so the low TSLA cap is in place before the first request.
  s.world.markets = s.world.markets.map((m) => (m.symbol === 'TSLA' ? { ...m, maxLeverage: 3 } : m));
  await registerWithDeployer(s);
  const cases: [Record<string, unknown>, string][] = [
    [{ strategy: 'degen', market: 'AAPL', side: 'long' }, 'invalid_body'],
    [{ ...change, strategy: 'yolo' }, 'invalid_strategy'],
    [{ ...change, market: 'NVDA' }, 'unsupported_market'],
    [{ ...change, maxLeverage: 30 }, 'invalid_leverage'],
    [{ ...change, market: 'TSLA', maxLeverage: 3 }, 'leverage_unavailable'],
  ];
  for (const [body, code] of cases) {
    const res = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings/challenge`, { json: body });
    assert.deepEqual([res.status, res.body.code], [400, code], JSON.stringify(body));
  }
  assert.equal(s.engine.db.get<{ n: number }>('SELECT count(*) AS n FROM settings_challenges')!.n, 0);
});

test('admin routes: disabled without a token, bearer auth only', async () => {
  const disabled = setup();
  const off = await disabled.call<ApiError>('/api/admin/kill-switch', { json: { on: true }, headers: { authorization: `Bearer ${ADMIN}` } });
  assert.deepEqual([off.status, off.body.code], [403, 'admin_disabled']);

  const s = setup({ ADMIN_TOKEN: ADMIN });
  const none = await s.call<ApiError>('/api/admin/kill-switch', { json: { on: true } });
  assert.deepEqual([none.status, none.body.code], [401, 'unauthorized']);
  const wrong = await s.call<ApiError>('/api/admin/kill-switch', { json: { on: true }, headers: { authorization: `Bearer ${ADMIN}x` } });
  assert.equal(wrong.status, 401);
  const ok = await s.call<{ killSwitch: boolean }>('/api/admin/kill-switch', { json: { on: true }, headers: { authorization: `Bearer ${ADMIN}` } });
  assert.deepEqual([ok.status, ok.body.killSwitch], [200, true]);
});

test('admin review moves a pending token to active', async () => {
  const s = setup({ ADMIN_TOKEN: ADMIN, AUTO_APPROVE: 'false' });
  await s.call('/api/tokens', { json: registration });
  const auth = { authorization: `Bearer ${ADMIN}` };
  const approved = await s.call<{ token: TokenSummary }>(`/api/admin/tokens/${TOKEN}/approve`, { method: 'POST', headers: auth });
  assert.equal(approved.body.token.status, 'active');
  const again = await s.call<ApiError>(`/api/admin/tokens/${TOKEN}/approve`, { method: 'POST', headers: auth });
  assert.deepEqual([again.status, again.body.code], [409, 'invalid_transition']);
});

test('SSE streams snapshots, then activity as it is recorded', async () => {
  const s = setup();
  const res = await s.app.request('/api/stream');
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (needle: string) => {
    while (!buffer.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${needle}`);
      buffer += decoder.decode(value, { stream: true });
    }
  };
  await readUntil('event: status');
  assert.match(buffer, /event: stats\ndata: \{/);

  activity(s.engine, { kind: 'claim', token: null, title: 'hello stream' });
  await readUntil('hello stream');
  assert.match(buffer, /event: activity\ndata: \{[^\n]*"title":"hello stream"/);
  await reader.cancel();
});

test('unknown API routes return JSON errors', async () => {
  const { call } = setup();
  const res = await call<ApiError>('/api/nope');
  assert.deepEqual([res.status, res.body.code], [404, 'not_found']);
});

test('POST rate limit keys on the proxy-appended (rightmost) X-Forwarded-For hop', async () => {
  const { call } = setup({ TRUST_PROXY: 'true' });
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    // A client prepends a fresh spoofed hop each time; the proxy appends the real address last.
    const res = await call<ApiError>('/api/tokens', { json: {}, headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` } });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(400), 429]);
});

test('API bodies over 16 KB are refused before parsing', async () => {
  const { call } = setup();
  const res = await call<ApiError>('/api/tokens', { json: { ...registration, padding: 'x'.repeat(20_000) } });
  assert.deepEqual([res.status, res.body.code], [413, 'payload_too_large']);
});

test('token candles are only proxied for registered tokens', async () => {
  const { call } = setup();
  const unknown = await call<ApiError>(`/api/tokens/${address(0x9999)}/candles`);
  assert.deepEqual([unknown.status, unknown.body.code], [404, 'not_found']);
  await call('/api/tokens', { json: registration });
  const known = await call<{ candles: unknown[] }>(`/api/tokens/${TOKEN}/candles`);
  assert.equal(known.status, 200);
});

test('SSE connections are capped per client address', async () => {
  const s = setup();
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  for (let i = 0; i < MAX_STREAMS_PER_IP; i++) {
    const res = await s.app.request('/api/stream');
    assert.equal(res.status, 200);
    readers.push(res.body!.getReader());
  }
  const over = await s.app.request('/api/stream');
  assert.deepEqual([over.status, ((await over.json()) as ApiError).code], [503, 'stream_busy']);
  await Promise.all(readers.map((r) => r.cancel()));
  // Cancelling runs each stream's cleanup on the next turn of the event loop (no wall-clock wait).
  await setImmediate();
  const again = await s.app.request('/api/stream');
  assert.equal(again.status, 200);
  await again.body!.cancel();
});

test('SSE events recorded while the initial snapshot is built arrive after it, not before', async () => {
  const s = setup();
  const venueStatus = s.engine.market.venueStatus.bind(s.engine.market);
  let once = true;
  s.engine.market.venueStatus = async () => {
    if (once) activity(s.engine, { kind: 'claim', token: null, title: 'during snapshot' });
    once = false;
    return venueStatus();
  };
  const res = await s.app.request('/api/stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('during snapshot')) buffer += decoder.decode((await reader.read()).value, { stream: true });
  assert.ok(buffer.indexOf('event: status') < buffer.indexOf('during snapshot'), buffer);
  await reader.cancel();
});

test('public status shows a short worker error without the RPC URL viem attaches', async () => {
  const t = createTestEngine();
  const key = 'k3yk3yk3yk3yk3yk3yk3yk3yk3yk3y00';
  const failing = {
    id: 'reconciler' as const,
    label: 'Reserve reconciler',
    intervalMs: 60_000,
    exclusive: false,
    run: async (): Promise<string> => {
      throw new HttpRequestError({ url: `https://rhc.example-rpc.io/v2/${key}`, body: { method: 'eth_getBalance' }, details: 'fetch failed' });
    },
  };
  const scheduler = new Scheduler(t.engine.db, [failing], t.engine.clock);
  const { app } = createApp(t.engine, scheduler);
  await scheduler.runNow('reconciler');
  const status = (await (await app.request('/api/status')).json()) as StatusResponse;
  const lastError = status.workers.find((w) => w.id === 'reconciler')?.lastError ?? '';
  assert.match(lastError, /HTTP request failed/);
  assert.ok(!lastError.includes(key) && !lastError.includes('example-rpc'), lastError);
});
