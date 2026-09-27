import { BRAND } from '@bellwether/shared';
import { Figure, FigureRow, figureStatus } from '../../components/Figure';
import { Muted, Section } from '../../components/Primitives';
import { Sparkline } from '../../components/Sparkline';
import { Fn } from '../../content/footnotes';
import { eth, int, usd } from '../../lib/format';
import { usePaperMode, useStats } from '../../lib/queries';

/**
 * §1 The ledger: the engine's running totals as serif figures with as-of and source. Secondary
 * figures are admitted only once they mean something (a trade happened, $BELL has burned).
 */
export function Ledger({ n }: { n: number }) {
  const q = useStats();
  const paper = usePaperMode();
  const s = q.data;
  const status = figureStatus(q);
  const common = { asOf: q.updatedAt, status, onRetry: q.refresh, source: { label: 'Proof', to: '/proof' } } as const;
  const history = s?.history ?? [];
  const extras = s ? [s.trades > 0, s.openPositions > 0, s.protocolBurned > 0].some(Boolean) : false;

  return (
    <Section
      id="ledger"
      n={n}
      label="The ledger"
      className="ld-ledger"
      title={
        <>
          Figures, not promises. <Muted>Every number here is the engine’s own, with the time it was read.</Muted>
        </>
      }
      lede={
        <>
          Totals across every token {BRAND.name} runs. The ledger is reconciled against on-chain and venue balances every minute
          <Fn id="figures" />.
        </>
      }
    >
      <FigureRow label="Engine totals" className="ld-ledger__main">
        <Figure
          {...common}
          size="lg"
          label="Burned, USD at the time of burn"
          value={s?.burnedUsd}
          kind="usd"
          paper={paper}
          sub={s ? `${eth(s.buybackEth)} spent across ${int(s.buybackCount)} ${s.buybackCount === 1 ? 'buyback' : 'buybacks'}` : undefined}
        />
        <Figure {...common} label="Creator fees claimed" value={s?.feesClaimedEth} kind="eth" unit="ETH" paper={paper} />
        <Figure {...common} label="Buybacks and burns" value={s?.buybackCount} kind="int" />
        <Figure {...common} label="Tokens live" value={s?.tokensActive} kind="int" sub={s && s.tokensPending > 0 ? `+${int(s.tokensPending)} pending review` : undefined} />
      </FigureRow>

      {s && extras && (
        <FigureRow label="Trading and protocol figures" className="ld-ledger__extra">
          {s.trades > 0 && (
            <Figure {...common} size="sm" label="Realized trading PnL" value={s.realizedPnlUsd} kind="usd" paper={paper} sub={`${int(s.trades)} closed ${s.trades === 1 ? 'trade' : 'trades'} · ${int(s.wins)} won`} />
          )}
          {s.openPositions > 0 && <Figure {...common} size="sm" label="Open positions" value={s.openPositions} kind="int" sub={`Unrealized ${usd(s.unrealizedPnlUsd, { signed: true })}`} />}
          {s.protocolBurned > 0 && <Figure {...common} size="sm" label={`$${BRAND.ticker} burned`} value={s.protocolBurned} kind="compact" unit={`$${BRAND.ticker}`} paper={paper} />}
        </FigureRow>
      )}

      <div className="ld-ledger__history">
        <p className="label">ETH spent on buybacks, per day, last 30 days</p>
        <Sparkline
          values={history.map((h) => h.buybackEth)}
          tone="brass"
          stepped
          label="ETH spent on buybacks per day over the last 30 days"
          fallback={s ? 'Totals since launch. The daily chart draws once seven days have had a burn.' : q.error ? 'Engine unreachable.' : 'Connecting to the engine…'}
        />
      </div>
    </Section>
  );
}
