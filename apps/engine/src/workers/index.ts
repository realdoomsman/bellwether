import type { WorkerId } from '@stepup/shared';
import type { Engine } from '../engine.ts';
import type { WorkerDef } from '../scheduler.ts';
import { runBuyback } from './buyback.ts';
import { runClaimer } from './claimer.ts';
import { runDiscovery } from './discovery.ts';
import { runGuardian } from './guardian.ts';
import { runReconciler } from './reconciler.ts';
import { runTrader } from './trader.ts';
import { runTreasury } from './treasury.ts';

const WORKERS: Record<WorkerId, { label: string; exclusive: boolean; maxBackoffFactor?: number; run: (e: Engine) => Promise<string> }> = {
  claimer: { label: 'Fee claimer', exclusive: true, run: runClaimer },
  treasury: { label: 'Treasury & bridge', exclusive: true, run: runTreasury },
  trader: { label: 'Trader', exclusive: true, run: runTrader },
  // The fast risk loop runs stops and exits: a failure must not stretch it past 2× its interval.
  guardian: { label: 'Risk guardian', exclusive: true, maxBackoffFactor: 2, run: runGuardian },
  buyback: { label: 'Buyback & burn', exclusive: true, run: runBuyback },
  discovery: { label: 'Token discovery', exclusive: false, run: runDiscovery },
  // Under the lock so balances are never read halfway through another worker's write.
  reconciler: { label: 'Reserve reconciler', exclusive: true, run: runReconciler },
};

export function workerDefs(engine: Engine): WorkerDef[] {
  return (Object.entries(WORKERS) as [WorkerId, (typeof WORKERS)[WorkerId]][]).map(([id, w]) => ({
    id,
    label: w.label,
    exclusive: w.exclusive,
    intervalMs: engine.config.intervals[id],
    maxBackoffFactor: w.maxBackoffFactor,
    run: () => w.run(engine),
  }));
}
