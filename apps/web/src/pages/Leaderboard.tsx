import { STRATEGIES, type LeaderboardBy, type LeaderboardResponse } from '@bellwether/shared';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { StatusPill } from '../components/Badges';
import { Empty, ErrorNotice, Loading, StaleNote } from '../components/DataState';
import { Segmented } from '../components/Segmented';
import { Pnl } from '../components/Stat';
import { TokenAvatar } from '../components/TokenAvatar';
import { compact, eth, pct } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { useLeaderboard } from '../lib/queries';
import '../styles/dashboard.css';

const TABS = [
  { value: 'burned', label: 'Most burned' },
  { value: 'pnl', label: 'Best PnL' },
  { value: 'fees', label: 'Most fees' },
] as const satisfies readonly { value: LeaderboardBy; label: string }[];

const METRIC_LABEL: Record<LeaderboardBy, string> = { burned: 'Supply burned', pnl: 'Total PnL', fees: 'Fees claimed' };

type Row = LeaderboardResponse['rows'][number];

function Metric({ by, row }: { by: LeaderboardBy; row: Row }) {
  const b = row.book;
  if (by === 'burned') {
    return (
      <>
        <span className="num lb__metric">{pct(b.supplyBurnedPct, { digits: 2 })}</span>
        <span className="muted small num"> {compact(b.tokensBurned)} tokens</span>
      </>
    );
  }
  if (by === 'pnl') return <Pnl value={b.realizedPnlUsd + b.unrealizedPnlUsd} />;
  return <span className="num lb__metric">{eth(b.feesClaimedEth)}</span>;
}

function isBy(v: string | null): v is LeaderboardBy {
  return v === 'burned' || v === 'pnl' || v === 'fees';
}

export default function Leaderboard() {
  useTitle('Leaderboard');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get('by');
  const by: LeaderboardBy = isBy(raw) ? raw : 'burned';
  const q = useLeaderboard(by);

  return (
    <div className="container page">
      <header className="page-head">
        <div>
          <p className="page-head__eyebrow">Leaderboard</p>
          <h1>Biggest steps up</h1>
          <p>Ranked straight from the engine’s ledger. Burned is measured as a share of each token’s total supply, so small caps compete fairly.</p>
        </div>
        <Segmented label="Rank by" options={TABS} value={by} onChange={(v) => setParams({ by: v }, { replace: true })} />
      </header>

      {!q.data ? (
        q.error ? (
          <ErrorNotice error={q.error} onRetry={q.refresh} what="The leaderboard" />
        ) : (
          <Loading label="leaderboard" height={56} count={6} />
        )
      ) : q.data.rows.length === 0 ? (
        <Empty
          title="No tokens ranked yet"
          icon="flame"
          action={
            <Link to="/launch" className="btn btn--primary btn--sm">
              Be the first
            </Link>
          }
        />
      ) : (
        <>
          <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
          <div className="table-wrap">
            <table className="table table--hover table--click table--stack lb">
              <caption className="sr-only">Tokens ranked by {METRIC_LABEL[by].toLowerCase()}</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Token</th>
                  <th scope="col" className="r">
                    {METRIC_LABEL[by]}
                  </th>
                  <th scope="col">Market</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.address} className={r.rank <= 3 ? 'lb__top' : ''} onClick={(e) => !(e.target as HTMLElement).closest('a') && navigate(`/t/${r.address}`)}>
                    <td data-label="Rank">
                      <span className={`lb__rank ${r.rank <= 3 ? 'led' : 'num'}`}>{r.rank}</span>
                    </td>
                    <td data-label="" className="stack-full">
                      <div className="tok">
                        <TokenAvatar image={r.image} symbol={r.symbol} size={32} />
                        <div className="tok__id">
                          <Link to={`/t/${r.address}`} className="tok__name">
                            {r.name}
                          </Link>
                          <span className="tok__sym num">${r.symbol}</span>
                        </div>
                      </div>
                    </td>
                    <td data-label={METRIC_LABEL[by]} className="r">
                      <Metric by={by} row={r} />
                    </td>
                    <td data-label="Market">
                      <span className="num">{r.market}</span> <span className="muted small">{STRATEGIES[r.strategy].label}</span>
                    </td>
                    <td data-label="Status">
                      <StatusPill status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
