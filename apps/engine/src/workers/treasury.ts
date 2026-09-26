/**
 * Treasury: nets realized profit against trading ETH (internal crossing), bridges the remaining
 * trading ETH to USDC once it is worth a bridge, and tops up venue margin. The kill switch halts
 * every outbound transfer (bridge deposit, margin top-up); the bookkeeping-only crossing still runs.
 */
import { activity, killSwitchOn, newId, type Engine } from '../engine.ts';
import { allocate, ethToGwei, gweiToEth, gweiToWei, microToUsd, usdToMicro } from '../units.ts';

export async function runTreasury(engine: Engine): Promise<string> {
  const { ledger } = engine;
  const parts: string[] = [];
  const ethUsd = await engine.market.ethUsd();

  const crossed = ledger.crossProfit({ refId: newId(), ethUsd, at: engine.clock() });
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

  parts.push(await bridgeTradingEth(engine, ethUsd));

  const venue = await engine.market.activeVenue();
  if (venue) {
    const top = await venue.topUpMargin();
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
  if (quote.impactPct > config.risk.bridgeMaxImpactPct) {
    return `bridge skipped: impact ${(quote.impactPct * 100).toFixed(2)}% > ${(config.risk.bridgeMaxImpactPct * 100).toFixed(2)}%`;
  }
  // The route's impact is self-reported by the bridge API; hold its output to the engine's own ETH/USD price.
  const minUsdc = gweiToEth(amount) * ethUsd * (1 - config.risk.bridgeMaxImpactPct);
  if (quote.expectedUsdc < minUsdc) {
    return `bridge skipped: quote $${quote.expectedUsdc.toFixed(2)} is below the $${minUsdc.toFixed(2)} floor at $${ethUsd.toFixed(2)}/ETH`;
  }

  const res = await io.bridge.ethToUsdc(gweiToWei(amount), config.risk.bridgeMaxImpactPct, minUsdc);
  const parts = amount === total ? legs.map((l) => l.gwei) : allocate(amount, legs.map((l) => l.gwei));
  const eth = gweiToEth(amount);
  engine.db.transaction(() => {
    ledger.recordConversion({
      refId: res.tx.hash,
      legs: legs.map((l, i) => ({ token: l.token, gwei: parts[i]! })).filter((l) => l.gwei > 0),
      usdcMicro: usdToMicro(res.expectedUsdc),
      tx: res.tx,
      at: engine.clock(),
    });
    activity(engine, {
      kind: 'bridge',
      token: null,
      title: `Bridged ${eth.toFixed(4)} ETH → $${res.expectedUsdc.toFixed(2)} USDC for the trading book`,
      amountEth: eth,
      amountUsd: res.expectedUsdc,
      txs: [res.tx],
    });
  });
  return `bridged ${eth} ETH → $${res.expectedUsdc.toFixed(2)}`;
}
