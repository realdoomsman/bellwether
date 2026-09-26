/**
 * Creator settings: the token deployer signs a single-use, 10-minute challenge (EIP-191
 * personal_sign) to change strategy, market, side or leverage.
 */
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { verifyMessage } from 'viem';
import { BRAND, STRATEGIES, type Address, type SettingsChallenge, type TokenSummary } from '@stepup/shared';
import { activity, type Engine } from '../engine.ts';
import { leverageBounds } from '../registration.ts';
import { getToken, updateToken, type TokenPatch, type TokenRow } from '../tokens.ts';
import { loadAggregates, tokenSummary } from '../views.ts';
import type { AppEnv } from './app.ts';
import { ApiFailure } from './errors.ts';
import { jsonBody, requireAddress, requireLeverage, requireMarket, requireSide, requireStrategy } from './validate.ts';

export const CHALLENGE_TTL_MS = 10 * 60_000;

export function challengeMessage(token: Address, nonce: string, expiresAt: number): string {
  return `${BRAND.name} settings update\nToken: ${token}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}`;
}

export function settingsRoutes(app: Hono<AppEnv>, engine: Engine): void {
  app.get('/api/tokens/:address/settings/challenge', (c) => {
    const address = requireAddress(c.req.param('address'));
    const t = getToken(engine.db, address);
    if (!t) throw new ApiFailure(404, 'not_found', 'Token not found');
    if (!t.deployer) throw new ApiFailure(409, 'no_deployer', 'The token deployer is unknown, so settings cannot be authorized');
    const now = engine.clock();
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = now + CHALLENGE_TTL_MS;
    const message = challengeMessage(address, nonce, expiresAt);
    engine.db.transaction(() => {
      engine.db.run('DELETE FROM settings_challenges WHERE expires_at < ?', [now - 86_400_000]);
      engine.db.run('INSERT INTO settings_challenges (nonce, token, message, expires_at) VALUES (?, ?, ?, ?)', [nonce, address, message, expiresAt]);
    });
    return c.json<SettingsChallenge>({ message, nonce, expiresAt, deployer: t.deployer });
  });

  app.post('/api/tokens/:address/settings', async (c) => {
    const address = requireAddress(c.req.param('address'));
    const body = await jsonBody(c.req);
    const t = getToken(engine.db, address);
    if (!t) throw new ApiFailure(404, 'not_found', 'Token not found');
    if (typeof body.nonce !== 'string' || typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
      throw new ApiFailure(400, 'invalid_body', 'nonce and a 0x-hex signature are required');
    }
    const challenge = engine.db.get<{ token: string; message: string; expires_at: number; used_at: number | null }>(
      'SELECT token, message, expires_at, used_at FROM settings_challenges WHERE nonce = ?',
      [body.nonce],
    );
    if (!challenge || challenge.token !== address || challenge.used_at !== null) {
      throw new ApiFailure(400, 'invalid_nonce', 'Unknown or already used challenge; request a new one');
    }
    if (challenge.expires_at < engine.clock()) throw new ApiFailure(400, 'nonce_expired', 'Challenge expired; request a new one');
    if (!t.deployer) throw new ApiFailure(409, 'no_deployer', 'The token deployer is unknown');

    const valid = await verifyMessage({ address: t.deployer, message: challenge.message, signature: body.signature as `0x${string}` }).catch(() => false);
    if (!valid) throw new ApiFailure(403, 'bad_signature', `Signature is not from the token deployer ${t.deployer}`);

    const patch = await validatePatch(engine, t, body);
    const at = engine.clock();
    engine.db.transaction(() => {
      const claimed = engine.db.run('UPDATE settings_challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL', [at, body.nonce as string]);
      if (claimed.changes !== 1) throw new ApiFailure(400, 'invalid_nonce', 'Challenge already used');
      updateToken(engine.db, address, patch, at);
      const changes = (Object.keys(patch) as (keyof TokenPatch)[]).map((k) => `${k} ${String(t[k])} → ${String(patch[k])}`);
      activity(engine, {
        kind: 'settings',
        token: { address, symbol: t.symbol },
        title: changes.length ? `$${t.symbol} settings updated: ${changes.join(', ')}` : `$${t.symbol} settings confirmed (no changes)`,
        market: patch.market ?? t.market,
      });
    });
    return c.json<TokenSummary>(tokenSummary(engine, getToken(engine.db, address)!, loadAggregates(engine)));
  });
}

/** Validates the requested fields against the merged settings; leverage is clamped into the new bounds when omitted. */
async function validatePatch(engine: Engine, t: TokenRow, body: Record<string, unknown>): Promise<TokenPatch> {
  const strategy = body.strategy === undefined ? t.strategy : requireStrategy(body.strategy);
  const side = body.side === undefined ? t.side : requireSide(body.side);
  const vm = await requireMarket(engine, body.market ?? t.market);
  let maxLeverage: number;
  if (body.maxLeverage !== undefined) {
    maxLeverage = requireLeverage(body.maxLeverage, strategy, vm.maxLeverage);
  } else if (!STRATEGIES[strategy].trades) {
    maxLeverage = 0;
  } else {
    const b = leverageBounds(strategy, vm.maxLeverage);
    maxLeverage = Math.min(b.max, Math.max(b.min, t.maxLeverage));
  }
  const patch: TokenPatch = {};
  if (strategy !== t.strategy) patch.strategy = strategy;
  if (side !== t.side) patch.side = side;
  if (vm.symbol !== t.market) patch.market = vm.symbol;
  if (maxLeverage !== t.maxLeverage) patch.maxLeverage = maxLeverage;
  return patch;
}
