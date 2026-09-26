/**
 * Treasury: nets realized profit against trading ETH (internal crossing), bridges the remaining
 * trading ETH to USDC once it is worth a bridge, and tops up venue margin.
 */
import { activity, newId, type Engine } from '../engine.ts';
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

  parts.push(await bridgeTradingEth(engine));

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

async function bridgeTradingEth(engine: Engine): Promise<string> {
  const { config, ledger, io } = engine;
  const legs = [...ledger.books()].filter(([, b]) => b.trading_eth > 0).map(([token, b]) => ({ token, gwei: b.trading_eth }));
  const total = legs.reduce((s, l) => s + l.gwei, 0);
  const minGwei = ethToGwei(config.risk.bridgeMinEth);
  if (total < minGwei) return `bridge waiting (${gweiToEth(total)} / ${config.risk.bridgeMinEth} ETH)`;

  // Buyback budgets and the gas reserve must stay on Robinhood Chain.
  const totals = ledger.totals();
  const reserved = ethToGwei(config.risk.rhcGasReserveEth) + totals.token_buyback_eth + totals.floor_buyback_eth;
  const balances = await io.wallet.balances();
  const amount = Math.min(total, Math.max(0, ethToGwei(balances.rhcEth) - reserved));
  if (amount < minGwei) return `bridge blocked: RHC balance ${balances.rhcEth} ETH leaves ${gweiToEth(amount)} ETH after reserves`;

  const quote = await io.bridge.quote(gweiToWei(amount));
  if (!quote) return 'bridge skipped: no route quote';
  if (quote.impactPct > config.risk.bridgeMaxImpactPct) {
    return `bridge skipped: impact ${(quote.impactPct * 100).toFixed(2)}% > ${(config.risk.bridgeMaxImpactPct * 100).toFixed(2)}%`;
  }

  const res = await io.bridge.ethToUsdc(gweiToWei(amount), config.risk.bridgeMaxImpactPct);
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
      title: `Bridged ${eth.toFixed(4)} ETH → $${res.expectedUsdc.toFixed(2)} USDC for the trading floor`,
      amountEth: eth,
      amountUsd: res.expectedUsdc,
      txs: [res.tx],
    });
  });
  return `bridged ${eth} ETH → $${res.expectedUsdc.toFixed(2)}`;
}
