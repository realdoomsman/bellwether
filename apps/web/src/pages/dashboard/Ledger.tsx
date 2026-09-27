import { BRAND, type StatsResponse } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { Figure, FigureRow, figureStatus } from '../../components/Figure';
import { SPARK_MIN_POINTS, Sparkline } from '../../components/Sparkline';
import { Pnl } from '../../components/Stat';
import { eth, int, pct0 } from '../../lib/format';
import { usePaperMode, useStats, useStatus, useTokens } from '../../lib/queries';

const PROOF = { label: 'Proof', to: '/proof' } as const;

/** A 30-day trend only once it has enough real points to mean something (brief §8.3). */
function trend(history: StatsResponse['history'], pick: (d: StatsResponse['history'][number]) => number, label: string, fallback: ReactNode): ReactNode {
  const values = history.map(pick);
  return values.filter((v) => v !== 0).length >= SPARK_MIN_POINTS ? <Sparkline values={values} label={label} tone="ink" height={28} /> : fallback;
}

/**
 * The engine's books in ledger figures. A figure is admitted only once it means something: realized
 * PnL after the first closed trade, trading equity while money is deployed, and burn totals once
 * something has burned (until then, what is queued to burn).
 */
export function Ledger() {
  const stats = useStats();
  const tokens = useTokens();
  const paper = usePaperMode();
  const launched = Boolean(useStatus().data?.protocolToken);
  const s = stats.data;
  const status = figureStatus(stats);
  const common = { asOf: stats.updatedAt, status, onRetry: stats.refresh } as const;
  const books = tokens.data?.tokens.map((t) => t.book);
  const queuedEth = books?.reduce((sum, b) => sum + b.tokenBuybackBudgetEth + b.protocolBuybackBudgetEth, 0);
  const queuedBellEth = books?.reduce((sum, b) => sum + b.protocolBuybackBudgetEth, 0);
  const closed = s ? s.wins + s.losses : 0;

  const figures: ReactNode[] = [
    <Figure
      key="fees"
      label="Fees claimed"
      value={s?.feesClaimedEth}
      kind="eth"
      unit="ETH"
      paper={paper}
      source={PROOF}
      sub={s ? trend(s.history, (d) => d.feesEth, 'Fees claimed per day, last 30 days', `from ${int(s.tokensActive)} live ${s.tokensActive === 1 ? 'token' : 'tokens'}`) : undefined}
      {...common}
    />,
  ];

  if (!s || s.buybackCount > 0) {
    figures.push(
      <Figure
        key="burned"
        label="Bought back and burned"
        value={s?.burnedUsd}
        kind="usd"
        paper={paper}
        source={PROOF}
        sub={s ? `${eth(s.buybackEth)} in ${int(s.buybackCount)} ${s.buybackCount === 1 ? 'buyback' : 'buybacks'}, valued at burn` : undefined}
        {...common}
      />,
    );
  } else {
    figures.push(<Figure key="queued" label="Queued to burn" value={queuedEth} kind="eth" unit="ETH" paper={paper} sub="burns at the next buyback run" source={PROOF} {...common} />);
  }

  if (s && (s.openPositions > 0 || s.tradingEquityUsd > 0)) {
    figures.push(
      <Figure
        key="equity"
        label="Trading equity"
        value={s.tradingEquityUsd}
        kind="usd"
        paper={paper}
        sub={
          <>
            {int(s.openPositions)} open {s.openPositions === 1 ? 'position' : 'positions'} · open PnL <Pnl value={s.unrealizedPnlUsd} />
          </>
        }
        {...common}
      />,
    );
  }

  if (s && closed > 0) {
    figures.push(
      <Figure
        key="pnl"
        label="Realized PnL"
        value={s.realizedPnlUsd}
        kind="usd"
        paper={paper}
        sub={`${int(s.wins)} won, ${int(s.losses)} lost · ${pct0(s.wins / closed)} win rate`}
        {...common}
      />,
    );
  }

  figures.push(
    <Figure
      key="tokens"
      label="Tokens live"
      value={s?.tokensActive}
      kind="int"
      sub={s ? (s.tokensPending > 0 ? `+${int(s.tokensPending)} pending review` : 'none waiting for review') : undefined}
      {...common}
    />,
  );

  if (s && s.protocolBurned > 0) {
    figures.push(<Figure key="bell" label={`$${BRAND.ticker} burned`} value={s.protocolBurned} kind="compact" unit={`$${BRAND.ticker}`} paper={paper} source={PROOF} sub="the protocol token, from every fee" {...common} />);
  } else {
    figures.push(
      <Figure key="bell" label={`$${BRAND.ticker} burn budget`} value={queuedBellEth} kind="eth" unit="ETH" paper={paper} sub={launched ? `queued for the next $${BRAND.ticker} buyback` : `queued until $${BRAND.ticker} launches`} {...common} />,
    );
  }

  return (
    <FigureRow label="The engine’s books" className={`live-ledger live-ledger--${figures.length}`}>
      {figures}
    </FigureRow>
  );
}
