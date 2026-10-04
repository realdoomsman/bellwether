/**
 * Reconciler: compares what the ledger says we hold against actual balances and stores the
 * snapshot served by /api/proof. Holding more than expected is fine (gas float, dust);
 * holding less is drift.
 *
 * Transfers between our own wallets are in neither balance while they travel: a Relay deposit (ETH gone from
 * RHC, or USDC booked but not on Arbitrum yet) and a Hyperliquid Bridge2 deposit not credited yet. Each counts as
 * held, under its own "in flight" wallet line, until it arrives or `IN_FLIGHT_BOUND_MS` passes; after that the
 * shortfall is reported as drift like any other.
 */
import { addressUrl, txUrl, type ReconciliationItem, type WalletBalance } from '@bellwether/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, type Engine } from '../engine.ts';
import { openPositions } from '../positions.ts';
import { gweiToEth, microToUsd } from '../units.ts';
import { PENDING_BRIDGE_KEY, USDC_IN_FLIGHT_KEY, type PendingBridge, type UsdcInFlight } from './treasury.ts';

export const RECONCILIATION_KEY = 'reconciliation';
/** Relay fills in minutes and Bridge2 credits in about one; a transfer still travelling after this is reported missing. */
export const IN_FLIGHT_BOUND_MS = 30 * 60_000;

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

/** Whether an in-flight USDC transfer has arrived (or will not: refunded). A failed lookup is not an arrival. */
async function arrived(engine: Engine, f: UsdcInFlight): Promise<boolean> {
  try {
    if (f.via === 'bridge') {
      const s = await engine.io.bridge.depositStatus({ requestId: f.requestId ?? '', hash: f.tx.hash });
      return (s.state === 'landed' && s.filled === true) || s.state === 'refunded' || s.state === 'reverted';
    }
    const venue = engine.io.venues.find((v) => v.id === f.via);
    return (await venue?.depositCredited?.(f.tx, f.at)) ?? false;
  } catch {
    return false;
  }
}

export async function runReconciler(engine: Engine): Promise<string> {
  const { io, ledger, config } = engine;
  const now = engine.clock();
  const balances = await io.wallet.balances();
  const ethUsd = await engine.market.ethUsd().catch(() => null);
  const t = ledger.totals();
  const unrealizedMicro = openPositions(engine.db).reduce((s, p) => s + p.unrealizedPnlMicro, 0);

  // A broadcast Relay deposit not booked yet: its ETH left the wallet but is still in `trading_eth`.
  const bridge = kvGet<PendingBridge>(engine.db, PENDING_BRIDGE_KEY);
  const ethInFlight = bridge?.hash && now - bridge.at < IN_FLIGHT_BOUND_MS ? { eth: gweiToEth(bridge.amountGwei), hash: bridge.hash } : null;

  const usdcInFlight: UsdcInFlight[] = [];
  const overdue: UsdcInFlight[] = [];
  for (const f of kvGet<UsdcInFlight[]>(engine.db, USDC_IN_FLIGHT_KEY) ?? []) {
    if (await arrived(engine, f)) continue;
    (now - f.at < IN_FLIGHT_BOUND_MS ? usdcInFlight : overdue).push(f);
  }
  const usdInFlight = usdcInFlight.reduce((s, f) => s + f.usd, 0);

  // Gas advanced from the float (gas debt) has left the wallet: until claims repay it, the wallet holds that much less than the budgets.
  const expectedEth = gweiToEth(Math.max(0, t.trading_eth + t.token_buyback_eth + t.protocol_buyback_eth - t.gas_debt_eth));
  const expectedUsd = microToUsd(t.trading_usd + t.deployed_usd + t.profit_token_usd + t.profit_protocol_usd + unrealizedMicro);
  const items = [
    item('ETH', 'rhc', expectedEth, balances.rhcEth + (ethInFlight?.eth ?? 0), ETH_TOLERANCE),
    item('USDC', 'hyperliquid', expectedUsd, balances.arbitrumUsdc + balances.venueEquityUsd + usdInFlight, USD_TOLERANCE),
  ];

  const address = io.wallet.address;
  const live = config.mode === 'live';
  const url = (chain: WalletBalance['chain']) => (live ? addressUrl(chain, address) : null);
  const wallets: WalletBalance[] = [
    { chain: 'rhc', address, url: url('rhc'), asset: 'ETH', amount: balances.rhcEth, usd: ethUsd === null ? null : balances.rhcEth * ethUsd },
    { chain: 'arbitrum', address, url: url('arbitrum'), asset: 'ETH', amount: balances.arbitrumEth, usd: ethUsd === null ? null : balances.arbitrumEth * ethUsd },
    { chain: 'arbitrum', address, url: url('arbitrum'), asset: 'USDC', amount: balances.arbitrumUsdc, usd: balances.arbitrumUsdc },
    { chain: 'hyperliquid', address, url: url('hyperliquid'), asset: 'USDC (margin equity)', amount: balances.venueEquityUsd, usd: balances.venueEquityUsd },
  ];
  // In-flight lines link the transfer itself.
  if (ethInFlight) {
    wallets.push({
      chain: 'rhc',
      address,
      url: live ? txUrl('rhc', ethInFlight.hash) : null,
      asset: 'ETH (in flight: bridging to Arbitrum USDC)',
      amount: ethInFlight.eth,
      usd: ethUsd === null ? null : ethInFlight.eth * ethUsd,
    });
  }
  for (const f of usdcInFlight) {
    const bridged = f.via === 'bridge';
    wallets.push({
      chain: bridged ? 'arbitrum' : 'hyperliquid',
      address,
      url: live ? txUrl(f.tx.chain, f.tx.hash) : null,
      asset: bridged ? 'USDC (in flight: bridge to Arbitrum)' : 'USDC (in flight: deposit not credited yet)',
      amount: f.usd,
      usd: f.usd,
    });
  }

  const previous = kvGet<ReconciliationSnapshot>(engine.db, RECONCILIATION_KEY);
  const snapshot: ReconciliationSnapshot = { checkedAt: now, items, wallets };
  engine.db.transaction(() => {
    kvSet(engine.db, RECONCILIATION_KEY, snapshot);
    kvSet(engine.db, USDC_IN_FLIGHT_KEY, usdcInFlight);
    for (const f of overdue) {
      activity(engine, {
        kind: 'risk',
        token: null,
        title: `$${f.usd.toFixed(2)} USDC ${f.via === 'bridge' ? 'bridged to Arbitrum' : `deposited to ${f.via}`} has not arrived after ${IN_FLIGHT_BOUND_MS / 60_000} minutes; reconciliation no longer counts it as in flight`,
        amountUsd: f.usd,
        txs: [f.tx],
      });
    }
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
  const inFlight = [ethInFlight ? `${ethInFlight.eth} ETH` : null, usdInFlight > 0 ? `$${usdInFlight.toFixed(2)}` : null].filter(Boolean);
  return (
    items.map((i) => `${i.asset}@${i.chain} ${i.ok ? 'ok' : 'DRIFT'} (${i.drift >= 0 ? '+' : ''}${i.drift.toFixed(4)})`).join(', ') +
    (inFlight.length > 0 ? `; in flight ${inFlight.join(' + ')}` : '')
  );
}
