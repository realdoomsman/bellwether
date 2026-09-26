/** Discovery: finds tokens launched with the protocol wallet as fee recipient and registers them. */
import { DEFAULT_STRATEGY, STRATEGIES } from '@stepup/shared';
import { kvGet, kvSet } from '../db.ts';
import type { Engine } from '../engine.ts';
import { errorMessage, log } from '../log.ts';
import { isImpersonation, registerToken } from '../registration.ts';
import { getToken } from '../tokens.ts';

const CURSOR_KEY = 'discovery.cursor';
export const DISCOVERY_DEFAULT_MARKET = 'AAPL';

export async function runDiscovery(engine: Engine): Promise<string> {
  // Scanning for the zero address would match every mint on the chain.
  if (!engine.config.walletConfigured) return 'skipped: protocol wallet not configured';
  const cursor = kvGet<string>(engine.db, CURSOR_KEY);
  const scan = await engine.io.discovery.scan(cursor === null ? null : BigInt(cursor));
  let added = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const c of scan.candidates) {
    if (getToken(engine.db, c.token)) continue;
    try {
      const verified = await engine.io.launchpads[c.launchpad].verify(c.token);
      if (verified.failure === 'lookup-failed') {
        failures.push(`${c.token}: ${verified.detail}`);
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
      failures.push(`${c.token}: ${errorMessage(err)}`);
    }
  }

  // Only advance past blocks whose candidates were all resolved; failures are retried next run.
  if (failures.length === 0) kvSet(engine.db, CURSOR_KEY, (scan.toBlock + 1n).toString());
  const summary = `scanned to block ${scan.toBlock}: ${scan.candidates.length} candidates, ${added} registered, ${skipped} skipped`;
  if (failures.length) throw new Error(`${summary}; ${failures.length} lookups failed (${failures.slice(0, 3).join('; ')})`);
  return summary;
}
