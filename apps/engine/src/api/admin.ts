/** Admin routes. Auth: `Authorization: Bearer <ADMIN_TOKEN>` only; disabled (403) when no token is configured. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Hono, MiddlewareHandler } from 'hono';
import type { TokenStatus, TokenSummary } from '@bellwether/shared';
import { activity, killSwitchOn, setKillSwitch, type Engine } from '../engine.ts';
import { WorkerBusyError, type Scheduler } from '../scheduler.ts';
import { decision, getToken, updateToken } from '../tokens.ts';
import { loadAggregates, tokenSummary } from '../views.ts';
import type { AppEnv } from './app.ts';
import { ApiFailure } from './errors.ts';
import { jsonBody, requireAddress } from './validate.ts';

type Action = 'approve' | 'reject' | 'pause' | 'resume';

const TRANSITIONS: Record<Action, { from: readonly TokenStatus[]; to: TokenStatus }> = {
  approve: { from: ['pending', 'rejected'], to: 'active' },
  reject: { from: ['pending', 'active', 'paused'], to: 'rejected' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
};

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export function adminAuth(adminToken: string | null): MiddlewareHandler<AppEnv> {
  const expected = adminToken === null ? null : digest(adminToken);
  return async (c, next) => {
    if (expected === null) throw new ApiFailure(403, 'admin_disabled', 'Admin API is disabled (ADMIN_TOKEN is not set)');
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !timingSafeEqual(digest(match[1]!.trim()), expected)) throw new ApiFailure(401, 'unauthorized', 'Missing or invalid admin token');
    await next();
  };
}

export function adminRoutes(app: Hono<AppEnv>, engine: Engine, scheduler: Scheduler): void {
  app.use('/api/admin/*', adminAuth(engine.config.adminToken));

  app.post('/api/admin/tokens/:address/:action', async (c) => {
    const address = requireAddress(c.req.param('address'));
    const action = c.req.param('action');
    if (!Object.hasOwn(TRANSITIONS, action)) throw new ApiFailure(404, 'not_found', `Unknown action ${action}`);
    const rule = TRANSITIONS[action as Action];
    const body = c.req.header('content-type')?.includes('json') ? await jsonBody(c.req) : {};
    const t = getToken(engine.db, address);
    if (!t) throw new ApiFailure(404, 'not_found', 'Token not found');
    if (!rule.from.includes(t.status)) {
      throw new ApiFailure(409, 'invalid_transition', `Cannot ${action} a ${t.status} token`, { status: t.status });
    }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : null;
    const at = engine.clock();
    const token = { address, symbol: t.symbol };
    engine.db.transaction(() => {
      if (rule.to === 'active') {
        updateToken(engine.db, address, { status: 'active', rejectedReason: null, decision: decision('collecting-fees', 'Approved — the engine picks it up on the next run', at) }, at);
        activity(engine, { kind: 'activated', token, title: `$${t.symbol} is live, trading ${t.market}`, market: t.market });
      } else if (rule.to === 'rejected') {
        const why = reason ?? 'Rejected by review';
        updateToken(engine.db, address, { status: 'rejected', rejectedReason: why, decision: decision('paused', `Rejected: ${why}`, at) }, at);
        activity(engine, { kind: 'risk', token, title: `$${t.symbol} rejected: ${why}` });
      } else {
        const why = reason ?? 'Paused by an operator';
        updateToken(engine.db, address, { status: 'paused', decision: decision('paused', why, at) }, at);
        activity(engine, { kind: 'risk', token, title: `$${t.symbol} paused: ${why}` });
      }
    });
    return c.json<{ ok: true; token: TokenSummary }>({ ok: true, token: tokenSummary(engine, getToken(engine.db, address)!, loadAggregates(engine)) });
  });

  app.post('/api/admin/kill-switch', async (c) => {
    const body = await jsonBody(c.req);
    if (typeof body.on !== 'boolean') throw new ApiFailure(400, 'invalid_body', 'Body must be {"on": boolean}');
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'operator';
    setKillSwitch(engine, body.on, reason);
    return c.json({ ok: true, killSwitch: killSwitchOn(engine) });
  });

  app.post('/api/admin/workers/:id/run', async (c) => {
    const id = c.req.param('id');
    if (!scheduler.has(id)) throw new ApiFailure(404, 'not_found', `Unknown worker ${id}`);
    try {
      const result = await scheduler.runNow(id);
      return c.json({ ok: true, worker: id, result });
    } catch (err) {
      if (err instanceof WorkerBusyError) throw new ApiFailure(409, 'already_running', err.message);
      throw err;
    }
  });
}
