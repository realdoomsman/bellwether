/**
 * Treasury: nets realized profit against trading ETH (internal crossing), bridges the remaining
 * trading ETH to USDC once it is worth a bridge, and tops up venue margin. The kill switch halts
 * every outbound transfer (bridge deposit, margin top-up); the bookkeeping-only crossing and the
 * resolution of an unconfirmed deposit still run.
 *
 * Every deposit is preceded by a durable intent (`treasury.pending_bridge`) holding the bridged legs, the
 * bridge's request id (before signing) and the tx hash (once broadcast). The conversion is booked in the
 * transaction that clears it; an intent left by a receipt timeout or a restart is resolved by looking the
 * deposit up, and no new deposit is sent while one is unresolved.
 */
import type { Address, VenueId } from '@bellwether/shared';
import { kvGet, kvSet } from '../db.ts';
import { activity, killSwitchOn, newId, type Engine } from '../engine.ts';
import { log } from '../log.ts';
import type { TxReceiptRef } from '../ports.ts';
import { allocate, ethToGwei, gweiToEth, gweiToWei, microToUsd, usdToMicro } from '../units.ts';

export const PENDING_BRIDGE_KEY = 'treasury.pending_bridge';
/**
 * A deposit neither the chain nor the bridge has seen this long after its intent was written was never
 * broadcast (or was dropped): its budget is released for a new deposit.
 */
export const BRIDGE_UNKNOWN_GRACE_MS = 30 * 60_000;
/** A deposit reported dropped (nonce taken by another tx) is trusted only this long after its intent: RPC replicas lag. */
export const BRIDGE_DROP_GRACE_MS = 15 * 60_000;
/** A deposit still unsettled this long after its intent is raised to the operator (once); it keeps blocking new deposits. */
export const BRIDGE_STUCK_ALERT_MS = 6 * 60 * 60_000;

export interface PendingBridge {
  legs: { token: Address; gwei: number }[];
  amountGwei: number;
  /** The bridge's id for the order, known before the deposit is signed. */
  requestId: string;
  expectedUsdc: number;
  /** Set as soon as the deposit is broadcast. */
  hash: string | null;
  /** The deposit's nonce, recorded with its hash: decides whether a hash without a receipt was dropped. */
  nonce?: number | null;
  /** Set once the operator was told the deposit is stuck. */
  stuckAlerted?: boolean;
  at: number;
}

/**
 * USDC that has left one place and not yet arrived at the next, so neither balance shows it: a booked Relay deposit
 * whose output isn't on Arbitrum yet, or a venue deposit (Arbitrum → Hyperliquid Bridge2) not credited yet.
 * Written here, settled by the reconciler, which counts each entry as held until it arrives or a bound passes.
 */
export const USDC_IN_FLIGHT_KEY = 'treasury.usdc_in_flight';

export interface UsdcInFlight {
  /** `bridge`: Relay delivering to Arbitrum (looked up by `requestId`); otherwise the venue crediting a deposit. */
  via: 'bridge' | VenueId;
  usd: number;
  tx: TxReceiptRef;
  requestId: string | null;
  /** When it was sent. */
  at: number;
}

function addUsdcInFlight(engine: Engine, entry: UsdcInFlight): void {
  kvSet(engine.db, USDC_IN_FLIGHT_KEY, [...(kvGet<UsdcInFlight[]>(engine.db, USDC_IN_FLIGHT_KEY) ?? []), entry]);
}

export async function runTreasury(engine: Engine): Promise<string> {
  const { ledger } = engine;
  const parts: string[] = [];
  const ethUsd = await engine.market.ethUsd();

  const resolved = await resolvePendingBridge(engine);
  if (resolved) parts.push(resolved);
  // An unresolved deposit's ETH is still in `trading_eth` but may already be gone: nothing else may spend it.
  const inFlight = kvGet<PendingBridge>(engine.db, PENDING_BRIDGE_KEY) !== null;

  const crossed = inFlight ? null : ledger.crossProfit({ refId: newId(), ethUsd, at: engine.clock() });
  if (crossed) {
    const usd = microToUsd(crossed.micro);
    activity(engine, {
      kind: 'bridge',
      token: null,
      title: `Netted $${usd.toFixed(2)} of trading profit into ${gweiToEth(crossed.gwei).toFixed(5)} ETH of buyback budget`,
      amountEth: gweiToEth(crossed.gwei),
      amountUsd: usd,
    });
    parts.push(`crossed $${usd.toFixed(2)} profit`);
  }

  if (killSwitchOn(engine)) {
    parts.push('kill switch on: bridge and margin top-up halted');
    return parts.join('; ');
  }

  if (!inFlight) parts.push(await bridgeTradingEth(engine, ethUsd));

  const venue = await engine.market.activeVenue();
  if (venue) {
    const top = await venue.topUpMargin();
    if (top.uncredited) addUsdcInFlight(engine, { via: venue.id, usd: top.uncredited.usd, tx: top.uncredited.tx, requestId: null, at: engine.clock() });
    if (top.movedUsd > 0) {
      activity(engine, {
        kind: 'bridge',
        token: null,
        title: `Moved $${top.movedUsd.toFixed(2)} USDC into ${venue.name} margin`,
        amountUsd: top.movedUsd,
        txs: top.txs,
      });
      parts.push(`topped up $${top.movedUsd.toFixed(2)}`);
    }
  }
  return parts.join('; ');
}

async function bridgeTradingEth(engine: Engine, ethUsd: number): Promise<string> {
  const { config, ledger, io } = engine;
  const legs = [...ledger.books()].filter(([, b]) => b.trading_eth > 0).map(([token, b]) => ({ token, gwei: b.trading_eth }));
  const total = legs.reduce((s, l) => s + l.gwei, 0);
  const minGwei = ethToGwei(config.risk.bridgeMinEth);
  if (total < minGwei) return `bridge waiting (${gweiToEth(total)} / ${config.risk.bridgeMinEth} ETH)`;

  // Buyback budgets and the gas reserve must stay on Robinhood Chain.
  const totals = ledger.totals();
  const reserved = ethToGwei(config.risk.rhcGasReserveEth) + totals.token_buyback_eth + totals.protocol_buyback_eth;
  const balances = await io.wallet.balances();
  const amount = Math.min(total, Math.max(0, ethToGwei(balances.rhcEth) - reserved));
  if (amount < minGwei) return `bridge blocked: RHC balance ${balances.rhcEth} ETH leaves ${gweiToEth(amount)} ETH after reserves`;

  const quote = await io.bridge.quote(gweiToWei(amount));
  if (!quote) return 'bridge skipped: no route quote';
  if (!(quote.impactPct <= config.risk.bridgeMaxImpactPct)) {
    return `bridge skipped: impact ${(quote.impactPct * 100).toFixed(2)}% > ${(config.risk.bridgeMaxImpactPct * 100).toFixed(2)}%`;
  }
  // The route's impact is self-reported by the bridge API; hold its output to the engine's own ETH/USD price.
  const minUsdc = gweiToEth(amount) * ethUsd * (1 - config.risk.bridgeMaxImpactPct);
  if (!(quote.expectedUsdc >= minUsdc)) {
    return `bridge skipped: quote $${quote.expectedUsdc.toFixed(2)} is below the $${minUsdc.toFixed(2)} floor at $${ethUsd.toFixed(2)}/ETH`;
  }

  const parts = amount === total ? legs.map((l) => l.gwei) : allocate(amount, legs.map((l) => l.gwei));
  const bridged = legs.map((l, i) => ({ token: l.token, gwei: parts[i]! })).filter((l) => l.gwei > 0);
  // The intent is written before the deposit is signed and gains its hash once broadcast. If the send then
  // fails or the process dies, it stays, and the next run looks the deposit up instead of sending another.
  const rec: { intent: PendingBridge | null } = { intent: null };
  const save = (intent: PendingBridge) => {
    rec.intent = intent;
    kvSet(engine.db, PENDING_BRIDGE_KEY, intent);
  };
  const res = await io.bridge.ethToUsdc(gweiToWei(amount), config.risk.bridgeMaxImpactPct, minUsdc, {
    prepared: ({ requestId, expectedUsdc }) => save({ legs: bridged, amountGwei: amount, requestId, expectedUsdc, hash: null, at: engine.clock() }),
    broadcast: (tx, nonce) => {
      if (!rec.intent) throw new Error('bridge broadcast before its intent was recorded');
      save({ ...rec.intent, hash: tx.hash, nonce: nonce ?? null });
    },
  });
  if (!rec.intent) throw new Error('bridge returned without recording its intent');
  bookBridge(engine, rec.intent, { expectedUsdc: res.expectedUsdc, tx: res.tx, gasWei: res.gasWei }, false);
  return `bridged ${gweiToEth(amount)} ETH → $${res.expectedUsdc.toFixed(2)}`;
}

/** Books a landed deposit (conversion + gas) and clears its intent, atomically. `filled`: the USDC is on Arbitrum already. */
function bookBridge(
  engine: Engine,
  intent: PendingBridge,
  res: { expectedUsdc: number; tx: TxReceiptRef; gasWei: bigint; filled?: boolean },
  recovered: boolean,
) {
  const eth = gweiToEth(intent.amountGwei);
  const at = engine.clock();
  engine.db.transaction(() => {
    // Gas first, out of the trading ETH this deposit came from: the conversion below empties those legs.
    engine.ledger.recordGas({ refId: res.tx.hash, legs: intent.legs, gasWei: res.gasWei, prefer: 'trading_eth', tx: res.tx, at });
    // Gas (this deposit's, or booked by other workers while it was in flight) may have drawn on these legs; never overdraw.
    const legs = intent.legs
      .map((l) => ({ token: l.token, gwei: Math.min(l.gwei, engine.ledger.balance(l.token, 'trading_eth')) }))
      .filter((l) => l.gwei > 0);
    const debited = legs.reduce((s, l) => s + l.gwei, 0);
    if (debited < intent.amountGwei) {
      log.warn('bridge conversion debits less trading ETH than was bridged', { tx: res.tx.hash, bridgedGwei: intent.amountGwei, debitedGwei: debited });
    }
    engine.ledger.recordConversion({ refId: res.tx.hash, legs, usdcMicro: usdToMicro(res.expectedUsdc), tx: res.tx, at });
    kvSet(engine.db, PENDING_BRIDGE_KEY, null);
    // Booked as USDC now; Relay delivers it on Arbitrum a few minutes later.
    if (!res.filled) addUsdcInFlight(engine, { via: 'bridge', usd: res.expectedUsdc, tx: res.tx, requestId: intent.requestId, at: intent.at });
    activity(engine, {
      kind: 'bridge',
      token: null,
      title: `Bridged ${eth.toFixed(4)} ETH → $${res.expectedUsdc.toFixed(2)} USDC for the trading book${recovered ? ' (confirmed after an unconfirmed send)' : ''}`,
      amountEth: eth,
      amountUsd: res.expectedUsdc,
      txs: [res.tx],
    });
  });
}

/**
 * Settles the intent of a deposit whose send never returned. Returns a status line, or null when there is none.
 * Never sends anything, so it runs with the kill switch on.
 */
async function resolvePendingBridge(engine: Engine): Promise<string | null> {
  const intent = kvGet<PendingBridge>(engine.db, PENDING_BRIDGE_KEY);
  if (!intent) return null;
  const eth = gweiToEth(intent.amountGwei);
  const status = await engine.io.bridge.depositStatus({ requestId: intent.requestId, hash: intent.hash, nonce: intent.nonce ?? null });
  switch (status.state) {
    case 'landed':
      bookBridge(engine, intent, { expectedUsdc: intent.expectedUsdc, tx: status.tx, gasWei: status.gasWei, filled: status.filled }, true);
      return `bridge deposit ${status.tx.hash} confirmed: booked ${eth} ETH → $${intent.expectedUsdc.toFixed(2)}`;
    case 'reverted':
    case 'refunded': {
      const at = engine.clock();
      const tx = status.tx;
      engine.db.transaction(() => {
        engine.ledger.recordGas({ refId: tx.hash, legs: intent.legs, gasWei: status.gasWei, prefer: 'trading_eth', tx, at });
        kvSet(engine.db, PENDING_BRIDGE_KEY, null);
        activity(engine, {
          kind: 'risk',
          token: null,
          title: `Bridge deposit of ${eth.toFixed(4)} ETH was ${status.state === 'reverted' ? 'reverted on-chain' : 'refunded by the bridge'}; the ETH stays in the trading budget`,
          amountEth: eth,
          txs: [tx],
        });
      });
      return `bridge deposit ${tx.hash} ${status.state}: ${eth} ETH stays in the trading budget`;
    }
    case 'dropped': {
      if (engine.clock() - intent.at < BRIDGE_DROP_GRACE_MS) return waitOrAlert(engine, intent, 'unconfirmed');
      engine.db.transaction(() => {
        kvSet(engine.db, PENDING_BRIDGE_KEY, null);
        activity(engine, {
          kind: 'risk',
          token: null,
          title: `Bridge deposit ${intent.hash} of ${eth.toFixed(4)} ETH was dropped (its nonce was used by another tx); its budget is released`,
          amountEth: eth,
        });
      });
      return `bridge deposit ${intent.hash} dropped: ${eth} ETH stays in the trading budget`;
    }
    case 'pending':
      return waitOrAlert(engine, intent, 'unconfirmed');
    case 'unknown': {
      if (engine.clock() - intent.at < BRIDGE_UNKNOWN_GRACE_MS) {
        return waitOrAlert(engine, intent, 'not seen yet');
      }
      engine.db.transaction(() => {
        kvSet(engine.db, PENDING_BRIDGE_KEY, null);
        activity(engine, {
          kind: 'risk',
          token: null,
          title: `Bridge deposit of ${eth.toFixed(4)} ETH (request ${intent.requestId}) never reached the chain; its budget is released`,
          amountEth: eth,
        });
      });
      return `bridge intent for ${eth} ETH released: the deposit never reached the chain`;
    }
  }
}

/** The status line of a deposit still blocking new ones; past BRIDGE_STUCK_ALERT_MS the operator is told, once. */
function waitOrAlert(engine: Engine, intent: PendingBridge, what: string): string {
  const id = intent.hash ?? intent.requestId;
  const ageMs = engine.clock() - intent.at;
  if (ageMs >= BRIDGE_STUCK_ALERT_MS && !intent.stuckAlerted) {
    const eth = gweiToEth(intent.amountGwei);
    engine.db.transaction(() => {
      kvSet(engine.db, PENDING_BRIDGE_KEY, { ...intent, stuckAlerted: true });
      activity(engine, {
        kind: 'risk',
        token: null,
        title: `Bridge deposit ${id} of ${eth.toFixed(4)} ETH is still unsettled after ${Math.round(ageMs / 3_600_000)}h; bridging and profit crossing are blocked until it resolves or ${PENDING_BRIDGE_KEY} is cleared`,
        amountEth: eth,
      });
    });
  }
  return `bridge deposit ${id} ${what}: waiting before any new deposit`;
}
