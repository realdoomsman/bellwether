/** Token routes: list, detail, verify (dry run), register, token candles. */
import type { Hono } from 'hono';
import {
  BRAND,
  LAUNCHPADS,
  type Address,
  type LaunchpadId,
  type RegisterResponse,
  type TokenCandlesResponse,
  type TokenDetailResponse,
  type TokensResponse,
  type VerifyCheck,
  type VerifyResponse,
} from '@stepup/shared';
import { listActivity } from '../activity.ts';
import { TtlCache } from '../cache.ts';
import type { Engine } from '../engine.ts';
import type { LaunchpadVerifyResult } from '../ports.ts';
import { listTrades } from '../positions.ts';
import { isImpersonation, registerToken } from '../registration.ts';
import { getToken, type TokenRow } from '../tokens.ts';
import { loadAggregates, publicTokens, summaries, tokenDetail, tokenSummary, tradeView } from '../views.ts';
import type { AppEnv } from './app.ts';
import { ApiFailure } from './errors.ts';
import {
  jsonBody,
  parseInterval,
  requireAddress,
  requireLaunchpad,
  requireLeverage,
  requireMarket,
  requireSide,
  requireStrategy,
} from './validate.ts';

const TOKEN_CANDLE_LIMIT = { '5m': 288, '15m': 192, '1h': 168, '1d': 180 } as const;

export function tokenRoutes(app: Hono<AppEnv>, engine: Engine): void {
  const candleCache = new TtlCache<TokenCandlesResponse>(60_000, engine.clock);

  app.get('/api/tokens', (c) => c.json<TokensResponse>({ tokens: summaries(engine, publicTokens(engine)) }));

  app.get('/api/tokens/:address', (c) => {
    const address = requireAddress(c.req.param('address'));
    const t = getToken(engine.db, address);
    if (!t) throw new ApiFailure(404, 'not_found', 'Token not found');
    return c.json<TokenDetailResponse>(
      tokenDetail(engine, t, loadAggregates(engine), {
        trades: listTrades(engine.db, { limit: 50, token: address }).map(tradeView),
        activity: listActivity(engine.db, { limit: 50, token: address }),
      }),
    );
  });

  app.get('/api/tokens/:address/verify', async (c) => {
    requireProtocolWallet(engine);
    const address = requireAddress(c.req.param('address'));
    const launchpad = requireLaunchpad(c.req.query('launchpad'));
    const existing = getToken(engine.db, address);
    const result = await verifyOnChain(engine, address, launchpad);
    return c.json<VerifyResponse>(verifyResponse(engine, address, launchpad, result, existing));
  });

  app.post('/api/tokens', async (c) => {
    requireProtocolWallet(engine);
    const body = await jsonBody(c.req);
    const address = requireAddress(body.address);
    const launchpad = requireLaunchpad(body.launchpad);
    const strategy = requireStrategy(body.strategy);
    const side = requireSide(body.side);
    const vm = await requireMarket(engine, body.market);
    const maxLeverage = requireLeverage(body.maxLeverage, strategy, vm.maxLeverage);

    const existing = getToken(engine.db, address);
    if (existing) throw new ApiFailure(409, 'already_registered', `$${existing.symbol} is already registered`, { status: existing.status });

    const result = await verifyOnChain(engine, address, launchpad);
    if (!result.ok) throw verifyFailure(result, launchpad);
    if (!result.metadata) throw new ApiFailure(502, 'rpc_error', 'Token metadata lookup failed; try again');
    if (isImpersonation(result.metadata, address, engine.config.protocolToken)) {
      throw new ApiFailure(422, 'impersonation', `"${result.metadata.name}" ($${result.metadata.symbol}) looks like the official $${BRAND.ticker} token`);
    }

    let row: TokenRow;
    try {
      row = registerToken(engine, {
        address,
        launchpad,
        market: vm.symbol,
        side,
        strategy,
        maxLeverage,
        verified: { ...result, metadata: result.metadata },
        autoDiscovered: false,
      });
    } catch (err) {
      // A concurrent registration of the same address won the insert.
      if (getToken(engine.db, address)) throw new ApiFailure(409, 'already_registered', 'Token is already registered');
      throw err;
    }
    return c.json<RegisterResponse>({ token: tokenSummary(engine, row, loadAggregates(engine)), activated: row.status === 'active' }, 201);
  });

  app.get('/api/tokens/:address/candles', async (c) => {
    const address = requireAddress(c.req.param('address'));
    const interval = parseInterval(c.req.query('interval'), '1h');
    const res = await candleCache
      .get(`${address}:${interval}`, async () => ({
        address,
        interval,
        candles: await engine.io.tokenData.candles(address, interval, TOKEN_CANDLE_LIMIT[interval]),
      }))
      .catch(() => {
        throw new ApiFailure(502, 'rpc_error', 'Token chart data is unavailable right now');
      });
    return c.json<TokenCandlesResponse>(res);
  });
}

/** Without a configured wallet there is nothing a token could route its fees to. */
function requireProtocolWallet(engine: Engine): void {
  if (!engine.config.walletConfigured) {
    throw new ApiFailure(503, 'wallet_not_configured', `${BRAND.name}'s protocol wallet isn't configured yet, so tokens can't be registered`);
  }
}

async function verifyOnChain(engine: Engine, address: Address, launchpad: LaunchpadId): Promise<LaunchpadVerifyResult> {
  try {
    return await engine.io.launchpads[launchpad].verify(address);
  } catch (err) {
    return {
      ok: false,
      failure: 'lookup-failed',
      detail: err instanceof Error ? err.message : String(err),
      deployer: null,
      metadata: null,
    };
  }
}

function verifyFailure(r: LaunchpadVerifyResult, launchpad: LaunchpadId): ApiFailure {
  switch (r.failure) {
    case 'no-contract':
      return new ApiFailure(422, 'no_contract', r.detail || 'No token contract at this address on Robinhood Chain');
    case 'wrong-launchpad':
      return new ApiFailure(422, 'wrong_launchpad', r.detail || `Token was not launched on ${LAUNCHPADS[launchpad].name}`);
    case 'fee-recipient-mismatch':
      return new ApiFailure(422, 'not_protocol_creator', r.detail || `${LAUNCHPADS[launchpad].feeField} is not the ${BRAND.name} protocol wallet`);
    default:
      return new ApiFailure(502, 'rpc_error', `On-chain lookup failed: ${r.detail}`);
  }
}

const NOT_CHECKED = 'Not checked (an earlier check failed)';

function verifyResponse(
  engine: Engine,
  address: Address,
  launchpad: LaunchpadId,
  r: LaunchpadVerifyResult,
  existing: TokenRow | null,
): VerifyResponse {
  const lp = LAUNCHPADS[launchpad];
  // Launchpad verification is sequential: the first failing step stops the rest.
  const stage = r.ok ? 3 : r.failure === 'fee-recipient-mismatch' ? 2 : r.failure === 'wrong-launchpad' ? 1 : 0;
  const step = (i: number, okDetail: string): { ok: boolean; detail: string } =>
    i < stage ? { ok: true, detail: okDetail } : i === stage ? { ok: false, detail: r.failure === 'lookup-failed' ? `Lookup failed: ${r.detail}` : r.detail } : { ok: false, detail: NOT_CHECKED };
  const impersonating = r.metadata ? isImpersonation(r.metadata, address, engine.config.protocolToken) : null;
  const checks: VerifyCheck[] = [
    { id: 'contract', label: 'Token contract exists on Robinhood Chain', ...step(0, 'Contract found') },
    { id: 'launchpad', label: `Launched on ${lp.name}`, ...step(1, `Deployed by the ${lp.name} factory`) },
    { id: 'fee-recipient', label: `${lp.feeField} is the ${BRAND.name} protocol wallet`, ...step(2, `Fees route to ${engine.config.network.protocolAddress}`) },
    {
      id: 'impersonation',
      label: `Not posing as $${BRAND.ticker}`,
      ok: impersonating === false,
      detail: impersonating === null ? 'Not checked (metadata unavailable)' : impersonating ? `Name or symbol resembles $${BRAND.ticker} / ${BRAND.protocolName}` : 'Name and symbol are fine',
    },
    {
      id: 'not-registered',
      label: 'Not registered yet',
      ok: existing === null,
      detail: existing ? `Already registered (status: ${existing.status})` : 'Ready to register',
    },
  ];
  return {
    ok: checks.every((c) => c.ok),
    checks,
    token: r.metadata ? { name: r.metadata.name, symbol: r.metadata.symbol, image: r.metadata.image, deployer: r.deployer } : null,
  };
}
