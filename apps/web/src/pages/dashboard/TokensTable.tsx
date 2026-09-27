import { STRATEGIES, STRATEGY_IDS, type StrategyId, type TokenStatus, type TokenSummary } from '@bellwether/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { StatusPill, VerdictPill } from '../../components/Badges';
import { Empty, ErrorNotice, Loading, StaleNote } from '../../components/DataState';
import { Icon } from '../../components/Icon';
import { Segmented } from '../../components/Segmented';
import { Pnl } from '../../components/Stat';
import { TokenAvatar } from '../../components/TokenAvatar';
import { compact, eth, leverage, pct } from '../../lib/format';
import { useTokens } from '../../lib/queries';

type Sort = 'fees' | 'burned' | 'pnl' | 'newest';
type StatusFilter = 'all' | Extract<TokenStatus, 'active' | 'pending' | 'paused'>;

const SORTS: Record<Sort, { label: string; key: (t: TokenSummary) => number }> = {
  fees: { label: 'Fees', key: (t) => t.book.feesClaimedEth },
  burned: { label: 'Burned', key: (t) => t.book.supplyBurnedPct },
  pnl: { label: 'PnL', key: (t) => t.book.realizedPnlUsd + t.book.unrealizedPnlUsd },
  newest: { label: 'Newest', key: (t) => t.createdAt },
};

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'paused', label: 'Paused' },
] as const satisfies readonly { value: StatusFilter; label: string }[];

export function TokensTable() {
  const q = useTokens();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('fees');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [strategy, setStrategy] = useState<StrategyId | 'all'>('all');

  if (!q.data) return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Tokens" /> : <Loading label="tokens" height={52} count={5} />;

  const needle = search.trim().toLowerCase();
  const rows = q.data.tokens
    .filter((t) => status === 'all' || t.status === status)
    .filter((t) => strategy === 'all' || t.strategy === strategy)
    .filter((t) => !needle || `${t.name} ${t.symbol} ${t.address} ${t.market}`.toLowerCase().includes(needle))
    .sort((a, b) => SORTS[sort].key(b) - SORTS[sort].key(a));

  return (
    <div className="tokens">
      <div className="toolbar">
        <div className="search toolbar__search">
          <Icon name="search" />
          <input className="input" type="search" placeholder="Search name, ticker, address, market" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tokens" />
        </div>
        <Segmented label="Status" size="sm" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
        <select className="select toolbar__select" value={strategy} onChange={(e) => setStrategy(e.target.value as StrategyId | 'all')} aria-label="Strategy">
          <option value="all">All strategies</option>
          {STRATEGY_IDS.map((id) => (
            <option key={id} value={id}>
              {STRATEGIES[id].label}
            </option>
          ))}
        </select>
        <select className="select toolbar__select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
          {(Object.keys(SORTS) as Sort[]).map((k) => (
            <option key={k} value={k}>
              Sort: {SORTS[k].label}
            </option>
          ))}
        </select>
      </div>
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />

      {q.data.tokens.length === 0 ? (
        <Empty
          title="No tokens yet"
          icon="steps"
          action={
            <Link to="/launch" className="btn btn--primary btn--sm">
              Launch the first one
            </Link>
          }
        >
          Tokens appear here the moment they’re registered — including ones waiting for review.
        </Empty>
      ) : rows.length === 0 ? (
        <Empty title="Nothing matches" icon="search">
          Try a different search or clear the filters.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table--hover table--click table--stack">
            <caption className="sr-only">Registered tokens, sorted by {SORTS[sort].label.toLowerCase()}</caption>
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col">Market</th>
                <th scope="col" className="r">
                  Fees
                </th>
                <th scope="col" className="r">
                  Burned
                </th>
                <th scope="col" className="r">
                  PnL
                </th>
                <th scope="col">Engine says</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.address} onClick={(e) => !(e.target as HTMLElement).closest('a') && navigate(`/t/${t.address}`)}>
                  <td data-label="" className="stack-full">
                    <div className="tok">
                      <TokenAvatar image={t.image} symbol={t.symbol} size={32} />
                      <div className="tok__id">
                        <Link to={`/t/${t.address}`} className="tok__name">
                          {t.name}
                        </Link>
                        <span className="tok__sym num">${t.symbol}</span>
                      </div>
                      <StatusPill status={t.status} />
                    </div>
                  </td>
                  <td data-label="Market">
                    <span className="num">{t.market}</span>{' '}
                    <span className="muted small">
                      {STRATEGIES[t.strategy].trades ? `≤${leverage(t.maxLeverage)} · ` : ''}
                      {STRATEGIES[t.strategy].label}
                    </span>
                  </td>
                  <td data-label="Fees" className="r num">
                    {eth(t.book.feesClaimedEth)}
                  </td>
                  <td data-label="Burned" className="r num">
                    {pct(t.book.supplyBurnedPct, { digits: 2 })}
                    <span className="muted small"> · {compact(t.book.tokensBurned)}</span>
                  </td>
                  <td data-label="PnL" className="r">
                    <Pnl value={t.book.realizedPnlUsd + t.book.unrealizedPnlUsd} compact />
                  </td>
                  <td data-label="" className="stack-full tokens__decision">
                    <VerdictPill verdict={t.decision.verdict} />
                    <span className="tokens__msg">{t.decision.message}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="field__hint">
        Showing {rows.length} of {q.data.tokens.length}. Rejected and retired tokens are only listed on their own pages.
      </p>
    </div>
  );
}
