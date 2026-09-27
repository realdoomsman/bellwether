import { BRAND, STRATEGIES, type TokenDetailResponse } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { Pnl } from '../../components/Stat';
import { compact, eth, int, usd } from '../../lib/format';

type Token = TokenDetailResponse['token'];

interface Line {
  label: string;
  value: ReactNode;
  note: ReactNode;
  /** Counts aren't simulated amounts, so they carry no PAPER tag. */
  count?: boolean;
}

/**
 * Everything the engine holds and has done for this token, from its ledger, as a ruled two-column
 * book. Trading lines only for trading strategies; realized PnL once a trade has closed.
 */
export function Book({ t, paper }: { t: Token; paper: boolean }) {
  const b = t.book;
  const trades = STRATEGIES[t.strategy].trades;
  const lines: Line[] = [
    { label: 'Fees claimed', value: eth(b.feesClaimedEth), note: 'all time, from the launchpad' },
    { label: 'Spent on buybacks', value: eth(b.buybackEth), note: `${compact(b.tokensBurned)} $${t.symbol} bought and burned` },
    { label: 'Token burn budget', value: eth(b.tokenBuybackBudgetEth), note: 'queued for the next buyback' },
    { label: `$${BRAND.ticker} burn budget`, value: eth(b.protocolBuybackBudgetEth), note: `queued to buy and burn $${BRAND.ticker}` },
  ];
  if (trades) {
    lines.push(
      { label: 'Trading budget', value: usd(b.tradingBudgetUsd), note: 'unspent, waiting for an entry' },
      { label: 'Collateral deployed', value: usd(b.deployedUsd), note: b.deployedUsd > 0 ? 'in the open position' : 'not in a position' },
    );
    if (b.trades > 0) {
      lines.push({
        label: 'Realized PnL',
        value: <Pnl value={b.realizedPnlUsd} />,
        note: (
          <>
            open <Pnl value={b.unrealizedPnlUsd} />
          </>
        ),
      });
    }
    lines.push({ label: 'Trades', value: int(b.trades), note: b.trades > 0 ? `${int(b.wins)} won` : 'none yet', count: true });
  }
  return (
    <dl className="book">
      {lines.map((l) => (
        <div key={l.label} className="book__line">
          <dt>
            {l.label}
            <span className="book__note">{l.note}</span>
          </dt>
          <dd className="num">
            {l.value}
            {paper && !l.count && <span className="paper-tag">PAPER</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
