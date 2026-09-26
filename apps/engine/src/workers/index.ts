import type { WorkerId } from '@floor/shared';
import type { Engine } from '../engine.ts';
import type { WorkerDef } from '../scheduler.ts';
import { runBuyback } from './buyback.ts';
import { runClaimer } from './claimer.ts';
import { runDiscovery } from './discovery.ts';
import { runGuardian } from './guardian.ts';
import { runReconciler } from './reconciler.ts';
import { runTrader } from './trader.ts';
import { runTreasury } from './treasury.ts';

const WORKERS: Record<WorkerId, { label: string; exclusive: boolean; run: (e: Engine) => Promise<string> }> = {
  claimer: { label: 'Fee claimer', exclusive: true, run: runClaimer },
  treasury: { label: 'Treasury & bridge', exclusive: true, run: runTreasury },
  trader: { label: 'Trader', exclusive: true, run: runTrader },
  guardian: { label: 'Risk guardian', exclusive: true, run: runGuardian },
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
    run: () => w.run(engine),
  }));
}
