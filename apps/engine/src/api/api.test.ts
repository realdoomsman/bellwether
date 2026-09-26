import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ApiError, RegisterResponse, SettingsChallenge, TokenSummary, VerifyResponse } from '@floor/shared';
import { activity } from '../engine.ts';
import { Scheduler } from '../scheduler.ts';
import { address, createTestEngine, okVerify } from '../testing/fakes.ts';
import { getToken } from '../tokens.ts';
import { workerDefs } from '../workers/index.ts';
import { createApp } from './app.ts';

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

test('register rejects tokens that fail on-chain checks or impersonate $FLOOR', async () => {
  const { call, world } = setup();
  world.verify.set(TOKEN, { ok: false, failure: 'fee-recipient-mismatch', detail: 'Creator wallet is 0xabc', deployer: world.deployer, metadata: null });
  const notOurs = await call<ApiError>('/api/tokens', { json: registration });
  assert.deepEqual([notOurs.status, notOurs.body.code], [422, 'not_protocol_creator']);

  world.verify.set(TOKEN, okVerify(world.deployer, { name: 'Floor Protocol', symbol: 'FL00R' }));
  const fake = await call<ApiError>('/api/tokens', { json: registration });
  assert.deepEqual([fake.status, fake.body.code], [422, 'impersonation']);
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

test('settings: the deployer signature applies changes once; replays and other signers are refused', async () => {
  const s = setup();
  const deployer = await registerWithDeployer(s);

  const challenge = await s.call<SettingsChallenge>(`/api/tokens/${TOKEN}/settings/challenge`);
  assert.equal(challenge.body.deployer, deployer.address);
  assert.match(challenge.body.message, new RegExp(`^Floor settings update\\nToken: ${TOKEN}\\nNonce: ${challenge.body.nonce}\\nExpires: `));

  const stranger = privateKeyToAccount(generatePrivateKey());
  const forged = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings`, {
    json: { nonce: challenge.body.nonce, signature: await stranger.signMessage({ message: challenge.body.message }), strategy: 'degen', maxLeverage: 10 },
  });
  assert.deepEqual([forged.status, forged.body.code], [403, 'bad_signature']);

  const signature = await deployer.signMessage({ message: challenge.body.message });
  const ok = await s.call<TokenSummary>(`/api/tokens/${TOKEN}/settings`, { json: { nonce: challenge.body.nonce, signature, strategy: 'degen', maxLeverage: 10 } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.strategy, ok.body.maxLeverage], ['degen', 10]);

  const replay = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings`, { json: { nonce: challenge.body.nonce, signature, strategy: 'steady' } });
  assert.deepEqual([replay.status, replay.body.code], [400, 'invalid_nonce']);
  assert.equal(getToken(s.engine.db, TOKEN)!.strategy, 'degen');
});

test('settings challenges expire after 10 minutes', async () => {
  const s = setup();
  const deployer = await registerWithDeployer(s);
  const challenge = await s.call<SettingsChallenge>(`/api/tokens/${TOKEN}/settings/challenge`);
  s.now.t += 10 * 60_000 + 1;
  const res = await s.call<ApiError>(`/api/tokens/${TOKEN}/settings`, {
    json: { nonce: challenge.body.nonce, signature: await deployer.signMessage({ message: challenge.body.message }), strategy: 'steady' },
  });
  assert.deepEqual([res.status, res.body.code], [400, 'nonce_expired']);
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
