import { BRAND, type StatsResponse } from '@bellwether/shared';
import { ErrorNotice, Loading, StaleNote } from '../../components/DataState';
import { Led } from '../../components/Led';
import { Sparkline } from '../../components/Sparkline';
import { Pnl } from '../../components/Stat';
import { compact, eth, int, pct0, usd } from '../../lib/format';
import { useStats } from '../../lib/queries';

function cumulative(values: number[]): number[] {
  let sum = 0;
  return values.map((v) => (sum += v));
}

function Tiles({ s }: { s: StatsResponse }) {
  const days = s.history.length;
  const fees = s.history.map((h) => h.feesEth);
  const burnedLine = cumulative(s.history.map((h) => h.buybackEth));
  const pnlLine = cumulative(s.history.map((h) => h.realizedPnlUsd));
  const pnlTotal = pnlLine[pnlLine.length - 1] ?? 0;
  const closed = s.wins + s.losses;

  return (
    <div className="live-stats">
      <article className="live-stat live-stat--hero">
        <p className="panel-label">Burned forever</p>
        <p className="live-stat__value live-stat__value--led">
          <Led text={usd(s.burnedUsd, { compact: true })} />
        </p>
        <p className="live-stat__sub num">
          {eth(s.buybackEth)} across {int(s.buybackCount)} buybacks
        </p>
        <Sparkline values={burnedLine} stepped label={`Cumulative ETH spent on buybacks over the last ${days} days, now ${eth(burnedLine[burnedLine.length - 1] ?? 0)}`} height={64} />
      </article>
      <article className="live-stat">
        <p className="panel-label">Fees claimed</p>
        <p className="live-stat__value live-stat__value--led">
          <Led text={eth(s.feesClaimedEth, { unit: false })} />
        </p>
        <p className="live-stat__sub">ETH, all time</p>
        <Sparkline values={fees} tone="neutral" label={`Daily fees claimed over the last ${days} days`} />
      </article>
      <article className="live-stat">
        <p className="panel-label">Realized PnL</p>
        <p className="live-stat__value">
          <Pnl value={s.realizedPnlUsd} compact />
        </p>
        <p className="live-stat__sub">
          Open: <Pnl value={s.unrealizedPnlUsd} compact />
        </p>
        <Sparkline values={pnlLine} tone={pnlTotal >= 0 ? 'up' : 'down'} label={`Cumulative realized PnL over the last ${days} days: ${usd(pnlTotal, { signed: true })}`} />
      </article>
      <dl className="live-stats__row">
        <div>
          <dt>Tokens live</dt>
          <dd className="num">
            {int(s.tokensActive)}
            {s.tokensPending > 0 && <span className="muted"> +{int(s.tokensPending)} pending</span>}
          </dd>
        </div>
        <div>
          <dt>Trading equity</dt>
          <dd className="num">{usd(s.tradingEquityUsd, { compact: true })}</dd>
        </div>
        <div>
          <dt>Trades · win rate</dt>
          <dd className="num">
            {int(s.trades)} · {closed > 0 ? pct0(s.wins / closed) : '—'}
          </dd>
        </div>
        <div>
          <dt>Open positions</dt>
          <dd className="num">{int(s.openPositions)}</dd>
        </div>
        <div>
          <dt>${BRAND.ticker} burned</dt>
          <dd className="num">{compact(s.protocolBurned)}</dd>
        </div>
      </dl>
    </div>
  );
}

export function LiveStats() {
  const q = useStats();
  if (!q.data) return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Protocol stats" /> : <Loading label="protocol stats" height={180} />;
  return (
    <>
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
      <Tiles s={q.data} />
    </>
  );
}
