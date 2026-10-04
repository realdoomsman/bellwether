import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from './config.ts';

// Throwaway test key (anvil account #0): never holds funds.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const LIVE = {
  ENGINE_MODE: 'live',
  LIVE_CONFIRM: 'real-funds',
  PROTOCOL_PRIVATE_KEY: KEY,
  ADMIN_TOKEN: 'a'.repeat(32),
  PUBLIC_URL: 'https://bellwether.example',
  DB_PATH: ':memory:',
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
}

test('live mode refuses to start without an admin token or a public https origin', () => {
  const { ADMIN_TOKEN: _admin, PUBLIC_URL: _url, ...bare } = LIVE;
  const found = problems(bare);
  assert.ok(found.some((p) => /requires ADMIN_TOKEN/.test(p)), found.join('\n'));
  assert.ok(found.some((p) => /requires PUBLIC_URL/.test(p)), found.join('\n'));
  assert.ok(problems({ ...LIVE, PUBLIC_URL: 'http://bellwether.example' }).some((p) => /https PUBLIC_URL/.test(p)));
  assert.deepEqual(problems(LIVE), []);
});

test('RPC fallbacks: free endpoints by default, a comma list when set, none on request, bad entries refused', () => {
  const def = loadConfig({}).network;
  assert.deepEqual(def.rhcRpcFallbackUrls, ['https://robinhood.drpc.org']);
  assert.deepEqual(def.arbitrumRpcFallbackUrls, ['https://arbitrum.drpc.org']);
  const set = loadConfig({ ROBINHOOD_RPC_FALLBACK_URLS: 'https://a.example/, https://b.example', ARBITRUM_RPC_FALLBACK_URLS: 'none' }).network;
  assert.deepEqual(set.rhcRpcFallbackUrls, ['https://a.example', 'https://b.example']);
  assert.deepEqual(set.arbitrumRpcFallbackUrls, []);
  assert.ok(problems({ ROBINHOOD_RPC_FALLBACK_URLS: 'https://a.example,ftp://b.example' }).some((p) => /ROBINHOOD_RPC_FALLBACK_URLS entry ftp:\/\/b\.example/.test(p)));
});

test('live mode keeps new tokens pending unless AUTO_APPROVE=true is explicit, and warns when it is', () => {
  const live = loadConfig(LIVE);
  assert.equal(live.autoApprove, false);
  assert.ok(!live.warnings.some((w) => /AUTO_APPROVE/.test(w)));
  const approving = loadConfig({ ...LIVE, AUTO_APPROVE: 'true' });
  assert.equal(approving.autoApprove, true);
  assert.ok(approving.warnings.some((w) => /AUTO_APPROVE=true/.test(w)));
});

test('live mode warns about public RPCs and missing alerts until they are configured', () => {
  const warned = loadConfig(LIVE).warnings.join('\n');
  for (const what of ['ROBINHOOD_RPC_URL', 'ARBITRUM_RPC_URL', 'no alerts']) assert.match(warned, new RegExp(what));
  // A copied .env.example spells the public endpoint out: still public.
  assert.ok(loadConfig({ ...LIVE, ROBINHOOD_RPC_URL: 'https://rpc.mainnet.chain.robinhood.com/' }).warnings.some((w) => /ROBINHOOD_RPC_URL/.test(w)));
  const quiet = loadConfig({
    ...LIVE,
    ROBINHOOD_RPC_URL: 'https://rhc.example/key',
    ARBITRUM_RPC_URL: 'https://arb.example/key',
    ALERT_DISCORD_WEBHOOK_URL: 'https://discord.example/hook',
  });
  assert.deepEqual(quiet.warnings, []);
});

test('paper defaults are unchanged: auto-approve on, no admin token or public URL needed, no warnings', () => {
  const paper = loadConfig({ DB_PATH: ':memory:' });
  assert.equal(paper.mode, 'paper');
  assert.equal(paper.autoApprove, true);
  assert.equal(paper.adminToken, null);
  assert.equal(paper.publicUrl, null);
  assert.deepEqual(paper.warnings, []);
});
