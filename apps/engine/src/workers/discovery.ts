/** Discovery: finds tokens launched with the protocol wallet as fee recipient and registers them. */
import { DEFAULT_STRATEGY, STRATEGIES, type Address } from '@bellwether/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, type Engine } from '../engine.ts';
import { shortError } from '../integrations/errors.ts';
import { log } from '../log.ts';
import { isImpersonation, registerToken } from '../registration.ts';
import { getToken } from '../tokens.ts';

const CURSOR_KEY = 'discovery.cursor';
/** Candidates whose lookup failed, by token: retried (holding the cursor) until they resolve or are given up on. */
const FAILED_KEY = 'discovery.failed';
export const DISCOVERY_DEFAULT_MARKET = 'AAPL';
/**
 * A candidate is given up on (and the cursor moves past it) only after this many failed runs spanning at
 * least `DISCOVERY_GIVE_UP_AFTER_MS`, so an RPC/explorer outage shorter than that never drops a launch.
 */
export const DISCOVERY_MAX_ATTEMPTS = 8;
export const DISCOVERY_GIVE_UP_AFTER_MS = 6 * 3_600_000;

interface FailedCandidate {
  attempts: number;
  firstAt: number;
  lastError: string;
  /** Given up on: not looked up again, kept only while another failure still holds the cursor. */
  gaveUp?: boolean;
}

export async function runDiscovery(engine: Engine): Promise<string> {
  // Scanning for the zero address would match every mint on the chain.
  if (!engine.config.walletConfigured) return 'skipped: protocol wallet not configured';
  const cursor = kvGet<string>(engine.db, CURSOR_KEY);
  const scan = await engine.io.discovery.scan(cursor === null ? null : BigInt(cursor));
  const failed = kvGet<Record<Address, FailedCandidate>>(engine.db, FAILED_KEY) ?? {};
  let added = 0;
  let skipped = 0;
  const failures: { token: Address; error: string }[] = [];

  const next: Record<Address, FailedCandidate> = {};
  for (const c of scan.candidates) {
    if (getToken(engine.db, c.token)) continue;
    const given = failed[c.token];
    if (given?.gaveUp) {
      next[c.token] = given;
      continue;
    }
    try {
      const verified = await engine.io.launchpads[c.launchpad].verify(c.token);
      if (verified.failure === 'lookup-failed') {
        failures.push({ token: c.token, error: verified.detail ?? 'lookup failed' });
        continue;
      }
      if (!verified.ok || !verified.metadata) {
        skipped++;
        continue;
      }
      if (isImpersonation(verified.metadata, c.token, engine.config.protocolToken)) {
        log.warn('discovery skipped brand impersonation', { token: c.token, symbol: verified.metadata.symbol });
        skipped++;
        continue;
      }
      registerToken(engine, {
        address: c.token,
        launchpad: c.launchpad,
        market: DISCOVERY_DEFAULT_MARKET,
        side: 'long',
        strategy: DEFAULT_STRATEGY,
        maxLeverage: STRATEGIES[DEFAULT_STRATEGY].maxLeverage,
        verified: { ...verified, metadata: verified.metadata },
        autoDiscovered: true,
      });
      added++;
    } catch (err) {
      // A creator registered the same token through the API while it was being verified.
      if (getToken(engine.db, c.token)) skipped++;
      else failures.push({ token: c.token, error: shortError(err) });
    }
  }

  // Failures hold the cursor so they are retried next run, until each has failed long enough to be given up on.
  const now = engine.clock();
  const retrying: string[] = [];
  const abandoned: Address[] = [];
  for (const f of failures) {
    const prev = failed[f.token];
    const entry = { attempts: (prev?.attempts ?? 0) + 1, firstAt: prev?.firstAt ?? now, lastError: f.error };
    if (entry.attempts >= DISCOVERY_MAX_ATTEMPTS && now - entry.firstAt >= DISCOVERY_GIVE_UP_AFTER_MS) {
      abandoned.push(f.token);
      next[f.token] = { ...entry, gaveUp: true };
      log.error('discovery gave up on a candidate', { token: f.token, attempts: entry.attempts, error: f.error });
      activity(engine, {
        kind: 'risk',
        token: null,
        title: `Discovery gave up on ${f.token} after ${entry.attempts} failed lookups (${f.error}); register it through the API if it is ours`,
      });
    } else {
      next[f.token] = entry;
      retrying.push(`${f.token}: ${f.error}`);
    }
  }
  // Only advance past blocks whose candidates all resolved or were given up on.
  if (retrying.length === 0) {
    kvSet(engine.db, CURSOR_KEY, (scan.toBlock + 1n).toString());
    kvSet(engine.db, FAILED_KEY, {});
  } else {
    kvSet(engine.db, FAILED_KEY, next);
  }
  const gaveUp = abandoned.length ? `, ${abandoned.length} given up` : '';
  const summary = `scanned to block ${scan.toBlock}: ${scan.candidates.length} candidates, ${added} registered, ${skipped} skipped${gaveUp}`;
  if (retrying.length) throw new Error(`${summary}; ${retrying.length} lookups failed (${retrying.slice(0, 3).join('; ')})`);
  return summary;
}
