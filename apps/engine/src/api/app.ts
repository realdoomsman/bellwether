/** HTTP API (every route of @stepup/shared api.ts) plus admin routes and the built web app. */
import type { HttpBindings } from '@hono/node-server';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import {
  isStockSymbol,
  type ActivityResponse,
  type CandlesResponse,
  type ConfigResponse,
  type HealthResponse,
  type LeaderboardBy,
  type LeaderboardResponse,
  type MarketsResponse,
  type PositionsResponse,
  type ProofResponse,
  type StatsResponse,
  type StatusResponse,
  type TokenSummary,
  type TradesResponse,
} from '@stepup/shared';
import { listActivity } from '../activity.ts';
import { TtlCache } from '../cache.ts';
import { VERSION, type Engine } from '../engine.ts';
import { errorMessage, log } from '../log.ts';
import { listTrades } from '../positions.ts';
import type { Scheduler } from '../scheduler.ts';
import { listTokens } from '../tokens.ts';
import {
  configResponse,
  loadAggregates,
  marketsResponse,
  proofResponse,
  statsResponse,
  statusResponse,
  summaries,
  tradeView,
} from '../views.ts';
import { adminRoutes } from './admin.ts';
import { ApiFailure } from './errors.ts';
import { TokenBucket, clientIp } from './ratelimit.ts';
import { settingsRoutes } from './settings.ts';
import { SnapshotTicker, streamRoutes } from './stream.ts';
import { tokenRoutes } from './tokens.ts';
import { parseIntParam, parseInterval, requireAddress } from './validate.ts';
import { serveWeb } from './web.ts';

export type AppEnv = { Bindings: HttpBindings };

const MARKET_CANDLE_LIMIT = { '5m': 288, '15m': 192, '1h': 168, '1d': 180 } as const;
/** API request bodies are small JSON objects; anything larger is refused before it is buffered. */
export const MAX_BODY_BYTES = 16 * 1024;
/** The settings challenge is rate-limited with the expensive routes, not the general POST budget. */
const CHALLENGE_ROUTE = '/api/tokens/:address/settings/challenge';
const CHALLENGE_PATH = /^\/api\/tokens\/[^/]+\/settings\/challenge$/;
const LEADERBOARD_KEYS: Record<LeaderboardBy, (t: TokenSummary) => number> = {
  burned: (t) => t.book.supplyBurnedPct,
  pnl: (t) => t.book.realizedPnlUsd,
  fees: (t) => t.book.feesClaimedEth,
};

export function createApp(engine: Engine, scheduler: Scheduler): { app: Hono<AppEnv>; ticker: SnapshotTicker } {
  const app = new Hono<AppEnv>();
  const ticker = new SnapshotTicker(engine, scheduler);
  const postLimiter = new TokenBucket(10, 10, engine.clock);
  // Routes that fan out to RPCs / upstream APIs or write a row, on their own budget.
  const expensiveLimiter = new TokenBucket(30, 30, engine.clock);
  const candleCache = new TtlCache<CandlesResponse>(60_000, engine.clock);
  const limit =
    (bucket: TokenBucket): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      if (!bucket.take(clientIp(c, engine.config.trustProxy))) throw new ApiFailure(429, 'rate_limited', 'Too many requests; slow down');
      await next();
    };
  const limitPost = limit(postLimiter);
  const limitExpensive = limit(expensiveLimiter);

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        // Token logos come from arbitrary HTTPS hosts (IPFS gateways, launchpad CDNs).
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
      // Explorer links open in new tabs; keep the default same-origin opener policy.
      referrerPolicy: 'strict-origin-when-cross-origin',
    }),
  );
  // The SSE stream must never be buffered by a compressor.
  app.use('/api/*', compress({ contentTypeFilter: (type) => /^application\/json/.test(type) }));

  const origins = engine.config.corsOrigins;
  app.use('/api/*', cors({ origin: origins.includes('*') ? '*' : [...origins], allowHeaders: ['Content-Type', 'Authorization'], maxAge: 600 }));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: `Request body is larger than ${MAX_BODY_BYTES} bytes`, code: 'payload_too_large' }, 413),
    }),
  );
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' && !CHALLENGE_PATH.test(c.req.path)) return limitPost(c, next);
    await next();
  });
  for (const path of ['/api/tokens/:address/verify', '/api/tokens/:address/candles', '/api/markets/:symbol/candles', CHALLENGE_ROUTE]) {
    app.use(path, limitExpensive);
  }

  app.get('/api/health', (c) =>
    c.json<HealthResponse>({ ok: true, mode: engine.config.mode, version: VERSION, uptimeSec: Math.round((engine.clock() - engine.startedAt) / 1000) }),
  );
  app.get('/api/status', async (c) => c.json<StatusResponse>(await statusResponse(engine, scheduler.health())));
  app.get('/api/stats', (c) => c.json<StatsResponse>(statsResponse(engine, loadAggregates(engine))));
  app.get('/api/config', async (c) => c.json<ConfigResponse>(await configResponse(engine)));
  app.get('/api/markets', async (c) => c.json<MarketsResponse>(await marketsResponse(engine)));

  app.get('/api/markets/:symbol/candles', async (c) => {
    const raw = c.req.param('symbol');
    if (!isStockSymbol(raw)) throw new ApiFailure(404, 'unknown_market', `Unknown market ${raw}`);
    const symbol = raw.toUpperCase();
    const interval = parseInterval(c.req.query('interval'), '15m');
    const res = await candleCache
      .get(`${symbol}:${interval}`, async () => ({ symbol, interval, candles: await engine.io.prices.candles(symbol, interval, MARKET_CANDLE_LIMIT[interval]) }))
      .catch(() => {
        throw new ApiFailure(502, 'rpc_error', 'Market data is unavailable right now');
      });
    return c.json<CandlesResponse>(res);
  });

  app.get('/api/positions', (c) => c.json<PositionsResponse>({ positions: loadAggregates(engine).positions }));

  app.get('/api/trades', (c) => {
    const limit = parseIntParam(c.req.query('limit'), 'limit', 50, 1, 200);
    return c.json<TradesResponse>({ trades: listTrades(engine.db, { limit }).map(tradeView) });
  });

  app.get('/api/activity', (c) => {
    const limit = parseIntParam(c.req.query('limit'), 'limit', 50, 1, 200);
    const before = c.req.query('before') === undefined ? undefined : parseIntParam(c.req.query('before'), 'before', 0, 1, Number.MAX_SAFE_INTEGER);
    const tokenParam = c.req.query('token');
    const token = tokenParam === undefined ? undefined : requireAddress(tokenParam, 'token');
    const events = listActivity(engine.db, { limit, ...(before !== undefined ? { before } : {}), ...(token ? { token } : {}) });
    const last = events[events.length - 1];
    return c.json<ActivityResponse>({ events, nextBefore: events.length === limit && last ? Number(last.id) : null });
  });

  app.get('/api/leaderboard', (c) => {
    const by = c.req.query('by') ?? 'burned';
    if (!Object.hasOwn(LEADERBOARD_KEYS, by)) throw new ApiFailure(400, 'invalid_query', 'by must be burned, pnl or fees');
    const key = LEADERBOARD_KEYS[by as LeaderboardBy];
    const rows = summaries(engine, listTokens(engine.db, ['active', 'paused']))
      .sort((a, b) => key(b) - key(a) || b.book.buybackEth - a.book.buybackEth)
      .map((t, i) => ({ ...t, rank: i + 1 }));
    return c.json<LeaderboardResponse>({ by: by as LeaderboardBy, rows });
  });

  app.get('/api/proof', (c) => c.json<ProofResponse>(proofResponse(engine)));

  tokenRoutes(app, engine);
  settingsRoutes(app, engine);
  streamRoutes(app, engine, ticker);
  adminRoutes(app, engine, scheduler);

  app.all('/api/*', () => {
    throw new ApiFailure(404, 'not_found', 'No such API route');
  });
  serveWeb(app, { dir: engine.config.webDist, publicUrl: engine.config.publicUrl, trustProxy: engine.config.trustProxy });

  app.notFound((c) => c.json({ error: 'Not found', code: 'not_found' }, 404));
  app.onError((err, c) => {
    if (err instanceof ApiFailure) return c.json(err.toBody(), err.status);
    log.error('unhandled API error', { method: c.req.method, path: c.req.path, error: errorMessage(err) });
    return c.json({ error: 'Internal error', code: 'internal' }, 500);
  });
  return { app, ticker };
}
