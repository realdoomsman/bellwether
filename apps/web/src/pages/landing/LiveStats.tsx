import { Figure, FigureRow, figureStatus } from '../../components/Figure';
import { eth, int } from '../../lib/format';
import { usePaperMode, useStats } from '../../lib/queries';

/** The ledger: headline engine figures with as-of and source (metrics with no meaning yet stay hidden). */
export function LiveStats() {
  const q = useStats();
  const paper = usePaperMode();
  const s = q.data;
  const status = figureStatus(q);
  const common = { asOf: q.updatedAt, status, onRetry: q.refresh, source: { label: 'Proof', to: '/proof' } } as const;
  return (
    <FigureRow label="Engine totals">
      <Figure {...common} label="Burned (USD at burn)" value={s?.burnedUsd} kind="usd" paper={paper} sub={s ? `${eth(s.buybackEth)} across ${int(s.buybackCount)} buybacks` : undefined} />
      <Figure {...common} label="Fees claimed" value={s?.feesClaimedEth} kind="eth" unit="ETH" paper={paper} />
      <Figure {...common} label="Buybacks" value={s?.buybackCount} kind="int" />
      <Figure {...common} label="Tokens live" value={s?.tokensActive} kind="int" sub={s && s.tokensPending > 0 ? `+${int(s.tokensPending)} pending review` : undefined} />
    </FigureRow>
  );
}
