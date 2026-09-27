/**
 * Creator settings. The client posts the complete desired settings; the engine validates them and issues
 * a 10-minute challenge whose text spells out the site, chain, token, every setting, nonce and expiry.
 * The token deployer personal_signs (EIP-191) that text and the engine applies exactly those settings,
 * so a signature can't be redeemed for anything other than what the deployer read.
 *
 * Challenges are stateless: the `nonce` handed to the client is a server-MACed ticket carrying the
 * settings, origin and expiry, so issuing one writes nothing (no storage to flood) and no third party can
 * void a challenge a deployer is signing. Single use is enforced when a ticket is redeemed: its nonce id
 * is inserted into `settings_challenges`, whose primary key rejects a replay.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { verifyMessage } from 'viem';
import { BRAND, CHAINS, STRATEGIES, type Address, type SettingsChallenge, type SettingsChange, type TokenSummary } from '@stepup/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, type Engine } from '../engine.ts';
import { getToken, updateToken, type TokenPatch, type TokenRow } from '../tokens.ts';
import { loadAggregates, tokenSummary } from '../views.ts';
import type { AppEnv } from './app.ts';
import { ApiFailure } from './errors.ts';
import { jsonBody, requireAddress, requireLeverage, requireMarket, requireSide, requireStrategy } from './validate.ts';
import { requestOrigin } from './web.ts';

export const CHALLENGE_TTL_MS = 10 * 60_000;

export function challengeMessage(p: {
  origin: string;
  token: Pick<TokenRow, 'address' | 'symbol'>;
  change: SettingsChange;
  nonce: string;
  expiresAt: number;
}): string {
  const s = STRATEGIES[p.change.strategy];
  return [
    `${BRAND.name} settings change`,
    '',
    `Site: ${p.origin}`,
    `Chain: ${CHAINS.rhc.name} (${CHAINS.rhc.chainId})`,
    `Token: $${p.token.symbol} ${p.token.address}`,
    '',
    `Strategy: ${s.label} (${s.id})`,
    `Market: ${p.change.market}`,
    `Side: ${p.change.side}`,
    `Max leverage: ${s.trades ? `${p.change.maxLeverage}x` : 'none (burn only)'}`,
    '',
    `Nonce: ${p.nonce}`,
    `Expires: ${new Date(p.expiresAt).toISOString()}`,
    '',
    `Only sign this on ${p.origin}. It proves you deployed the token and applies exactly these settings; nothing is sent on-chain.`,
  ].join('\n');
}

const MAC_KEY_KV = 'settings.mac_key';

interface Ticket {
  token: Address;
  change: SettingsChange;
  /** Random id shown in the signed message and recorded once redeemed. */
  id: string;
  expiresAt: number;
  origin: string;
}

/** Per-deployment MAC key, created on first use and kept in the database so tickets survive restarts. */
function macKey(engine: Engine): Buffer {
  const stored = kvGet<string>(engine.db, MAC_KEY_KV);
  if (stored) return Buffer.from(stored, 'hex');
  const key = randomBytes(32);
  kvSet(engine.db, MAC_KEY_KV, key.toString('hex'));
  return key;
}

function issueTicket(engine: Engine, ticket: Ticket): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
  return `${payload}.${createHmac('sha256', macKey(engine)).update(payload).digest('base64url')}`;
}

/** Returns the ticket when `raw` carries a valid MAC; null for anything forged, truncated or malformed. */
function readTicket(engine: Engine, raw: string): Ticket | null {
  const [payload, mac, ...rest] = raw.split('.');
  if (!payload || !mac || rest.length) return null;
  const expected = createHmac('sha256', macKey(engine)).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Ticket;
  } catch {
    return null;
  }
}

export function settingsRoutes(app: Hono<AppEnv>, engine: Engine): void {
  app.post('/api/tokens/:address/settings/challenge', async (c) => {
    const address = requireAddress(c.req.param('address'));
    const body = await jsonBody(c.req);
    const t = getToken(engine.db, address);
    if (!t) throw new ApiFailure(404, 'not_found', 'Token not found');
    if (!t.deployer) throw new ApiFailure(409, 'no_deployer', 'The token deployer is unknown, so settings cannot be authorized');
    const change = await validateChange(engine, body);

    const ticket: Ticket = {
      token: address,
      change,
      id: randomBytes(16).toString('hex'),
      expiresAt: engine.clock() + CHALLENGE_TTL_MS,
      // Where the signer is told the request came from: PUBLIC_URL, else this request's own origin.
      origin: requestOrigin(c, engine.config) || new URL(c.req.url).origin,
    };
    const message = challengeMessage({ origin: ticket.origin, token: t, change, nonce: ticket.id, expiresAt: ticket.expiresAt });
    return c.json<SettingsChallenge>({ message, nonce: issueTicket(engine, ticket), expiresAt: ticket.expiresAt, deployer: t.deployer, change });
  });

  app.post('/api/tokens/:address/settings', async (c) => {
    const address = requireAddress(c.req.param('address'));
    const body = await jsonBody(c.req);
    const t = getToken(engine.db, address);
    if (!t) throw new ApiFailure(404, 'not_found', 'Token not found');
    if (typeof body.nonce !== 'string' || typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
      throw new ApiFailure(400, 'invalid_body', 'nonce and a 0x-hex signature are required');
    }
    const ticket = readTicket(engine, body.nonce);
    if (!ticket || ticket.token !== address) throw new ApiFailure(400, 'invalid_nonce', 'Unknown or already used challenge; request a new one');
    if (ticket.expiresAt < engine.clock()) throw new ApiFailure(400, 'nonce_expired', 'Challenge expired; request a new one');
    if (!t.deployer) throw new ApiFailure(409, 'no_deployer', 'The token deployer is unknown');

    const message = challengeMessage({ origin: ticket.origin, token: t, change: ticket.change, nonce: ticket.id, expiresAt: ticket.expiresAt });
    const valid = await verifyMessage({ address: t.deployer, message, signature: body.signature as `0x${string}` }).catch(() => false);
    if (!valid) throw new ApiFailure(403, 'bad_signature', `Signature is not from the token deployer ${t.deployer}`);

    // Exactly the signed settings, re-checked in case the venue changed since the challenge was issued.
    const change = await validateChange(engine, { ...ticket.change });
    const patch = diff(t, change);
    const at = engine.clock();
    engine.db.transaction(() => {
      // Redeemed ids are kept only until their ticket would have expired anyway.
      engine.db.run('DELETE FROM settings_challenges WHERE expires_at < ?', [at]);
      const redeemed = engine.db.run(
        'INSERT INTO settings_challenges (nonce, token, message, change, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (nonce) DO NOTHING',
        [ticket.id, address, message, JSON.stringify(ticket.change), ticket.expiresAt, at],
      );
      if (redeemed.changes !== 1) throw new ApiFailure(400, 'invalid_nonce', 'Challenge already used');
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

/** The complete desired settings, validated with the same rules as registration. */
async function validateChange(engine: Engine, body: Record<string, unknown>): Promise<SettingsChange> {
  for (const field of ['strategy', 'market', 'side', 'maxLeverage'] as const) {
    if (body[field] === undefined) throw new ApiFailure(400, 'invalid_body', `${field} is required: send the complete desired settings`);
  }
  const strategy = requireStrategy(body.strategy);
  const side = requireSide(body.side);
  const vm = await requireMarket(engine, body.market);
  const maxLeverage = requireLeverage(body.maxLeverage, strategy, vm);
  return { strategy, market: vm.symbol, side, maxLeverage };
}

function diff(t: TokenRow, change: SettingsChange): TokenPatch {
  const patch: TokenPatch = {};
  if (change.strategy !== t.strategy) patch.strategy = change.strategy;
  if (change.side !== t.side) patch.side = change.side;
  if (change.market !== t.market) patch.market = change.market;
  if (change.maxLeverage !== t.maxLeverage) patch.maxLeverage = change.maxLeverage;
  return patch;
}
