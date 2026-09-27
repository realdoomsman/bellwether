/**
 * Reconciler: compares what the ledger says we hold against actual balances and stores the
 * snapshot served by /api/proof. Holding more than expected is fine (gas float, dust);
 * holding less is drift.
 */
import { addressUrl, type ReconciliationItem, type WalletBalance } from '@bellwether/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, type Engine } from '../engine.ts';
import { openPositions } from '../positions.ts';
import { gweiToEth, microToUsd } from '../units.ts';

export const RECONCILIATION_KEY = 'reconciliation';

export interface ReconciliationSnapshot {
  checkedAt: number;
  items: ReconciliationItem[];
  wallets: WalletBalance[];
}

const ETH_TOLERANCE = { abs: 0.0005, rel: 0.01 };
const USD_TOLERANCE = { abs: 1, rel: 0.02 };

function item(asset: string, chain: ReconciliationItem['chain'], expected: number, actual: number, tol: { abs: number; rel: number }): ReconciliationItem {
  const drift = actual - expected;
  return { asset, chain, expected, actual, drift, ok: drift >= -Math.max(tol.abs, tol.rel * expected) };
}

export async function runReconciler(engine: Engine): Promise<string> {
  const { io, ledger, config } = engine;
  const balances = await io.wallet.balances();
  const ethUsd = await engine.market.ethUsd().catch(() => null);
  const t = ledger.totals();
  const unrealizedMicro = openPositions(engine.db).reduce((s, p) => s + p.unrealizedPnlMicro, 0);

  const expectedEth = gweiToEth(t.trading_eth + t.token_buyback_eth + t.protocol_buyback_eth);
  const expectedUsd = microToUsd(t.trading_usd + t.deployed_usd + t.profit_token_usd + t.profit_protocol_usd + unrealizedMicro);
  const items = [
    item('ETH', 'rhc', expectedEth, balances.rhcEth, ETH_TOLERANCE),
    item('USDC', 'hyperliquid', expectedUsd, balances.arbitrumUsdc + balances.venueEquityUsd, USD_TOLERANCE),
  ];

  const address = io.wallet.address;
  const url = (chain: WalletBalance['chain']) => (config.mode === 'live' ? addressUrl(chain, address) : null);
  const wallets: WalletBalance[] = [
    { chain: 'rhc', address, url: url('rhc'), asset: 'ETH', amount: balances.rhcEth, usd: ethUsd === null ? null : balances.rhcEth * ethUsd },
    { chain: 'arbitrum', address, url: url('arbitrum'), asset: 'ETH', amount: balances.arbitrumEth, usd: ethUsd === null ? null : balances.arbitrumEth * ethUsd },
    { chain: 'arbitrum', address, url: url('arbitrum'), asset: 'USDC', amount: balances.arbitrumUsdc, usd: balances.arbitrumUsdc },
    { chain: 'hyperliquid', address, url: url('hyperliquid'), asset: 'USDC (margin equity)', amount: balances.venueEquityUsd, usd: balances.venueEquityUsd },
  ];

  const previous = kvGet<ReconciliationSnapshot>(engine.db, RECONCILIATION_KEY);
  const snapshot: ReconciliationSnapshot = { checkedAt: engine.clock(), items, wallets };
  engine.db.transaction(() => {
    kvSet(engine.db, RECONCILIATION_KEY, snapshot);
    for (const it of items) {
      const was = previous?.items.find((p) => p.asset === it.asset && p.chain === it.chain);
      if (!it.ok && (was?.ok ?? true)) {
        activity(engine, {
          kind: 'risk',
          token: null,
          title: `Reserve drift on ${it.chain} ${it.asset}: ledger expects ${it.expected.toFixed(4)}, wallet holds ${it.actual.toFixed(4)}`,
        });
      }
    }
  });
  return items.map((i) => `${i.asset}@${i.chain} ${i.ok ? 'ok' : 'DRIFT'} (${i.drift >= 0 ? '+' : ''}${i.drift.toFixed(4)})`).join(', ');
}
