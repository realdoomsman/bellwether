import { LAUNCHPAD_IDS, LAUNCHPADS, STRATEGIES, STRATEGY_IDS, type LaunchpadId, type StrategyId, type TokenSummary } from '@bellwether/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { StatusPill, VerdictPill } from '../../components/Badges';
import { Empty, ErrorNotice, Loading, StaleNote } from '../../components/DataState';
import { Icon } from '../../components/Icon';
import { Medallion } from '../../components/Medallion';
import { Segmented } from '../../components/Segmented';
import { Pnl } from '../../components/Stat';
import { compact, etDateTime, eth, leverage, pct, relTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useActivity, useTokens } from '../../lib/queries';
import { useFlip } from './useFlip';

type SortKey = 'name' | 'fees' | 'burned' | 'pnl' | 'ring';
type StatusFilter = 'all' | 'active' | 'pending' | 'paused';
interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

const SORT_LABEL: Record<SortKey, string> = { name: 'name', fees: 'fees claimed', burned: 'share of supply burned', pnl: 'PnL', ring: 'last burn' };

/** Burn share with enough digits that small burns don't print as 0.00%. */
function burnedPct(frac: number): string {
  return pct(frac, { digits: frac > 0 && frac < 0.0001 ? 4 : 2 });
}

/** Market and strategy in one line: "TSLA · Degen ≤ 20×". */
function strategyLine(t: TokenSummary): string {
  const s = STRATEGIES[t.strategy];
  return s.trades ? `${s.label} ≤ ${leverage(t.maxLeverage)}` : s.label;
}

/** Pending and paused tokens already show their status by the name; the verdict would repeat it. */
function statusSaysIt(t: TokenSummary): boolean {
  return (t.status === 'pending' && t.decision.verdict === 'pending-review') || (t.status === 'paused' && t.decision.verdict === 'paused');
}

function SortHeader({ k, label, sort, onSort, align = 'r', className = '' }: { k: SortKey; label: string; sort: Sort; onSort: (k: SortKey) => void; align?: 'l' | 'r'; className?: string }) {
  const active = sort.key === k;
  return (
    <th scope="col" className={`${align === 'r' ? 'r ' : ''}${className}`} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort" onClick={() => onSort(k)}>
        {label}
        <Icon name="sort" size={12} className="sort__icon" />
      </button>
    </th>
  );
}

function Identity({ t }: { t: TokenSummary }) {
  return (
    <span className="tok">
      <Medallion image={t.image} symbol={t.symbol} address={t.address} size={32} />
      <span className="tok__id">
        <Link to={`/t/${t.address}`} className="tok__name">
          {t.name}
        </Link>
        <span className="tok__sym num">${t.symbol}</span>
      </span>
      <StatusPill status={t.status} />
    </span>
  );
}

/**
 * Every listed token with the engine's decision in plain words. Search (name, ticker, address,
 * market; "/" focuses it), filters for status, strategy and launchpad, sortable headers, and rows that
 * glide to their new places when the order changes. Phones get two-line rows.
 */
export function TokensTable() {
  const q = useTokens();
  const activity = useActivity();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [strategy, setStrategy] = useState<StrategyId | 'all'>('all');
  const [launchpad, setLaunchpad] = useState<LaunchpadId | 'all'>('all');
  const [sort, setSort] = useState<Sort>({ key: 'fees', dir: -1 });
  const searchRef = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTableSectionElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Last burn per token, from the live activity the dashboard already streams.
  const lastRing = new Map<string, number>();
  for (const e of activity.data?.events ?? []) {
    if (e.kind === 'buyback' && e.token && !lastRing.has(e.token.toLowerCase())) lastRing.set(e.token.toLowerCase(), e.at);
  }

  const tokens = q.data?.tokens ?? [];
  const needle = search.trim().toLowerCase();
  const value: Record<SortKey, (t: TokenSummary) => number | string> = {
    name: (t) => t.name.toLowerCase(),
    fees: (t) => t.book.feesClaimedEth,
    burned: (t) => t.book.supplyBurnedPct,
    pnl: (t) => t.book.realizedPnlUsd + t.book.unrealizedPnlUsd,
    ring: (t) => lastRing.get(t.address.toLowerCase()) ?? -Infinity,
  };
  const rows = tokens
    .filter((t) => status === 'all' || t.status === status)
    .filter((t) => strategy === 'all' || t.strategy === strategy)
    .filter((t) => launchpad === 'all' || t.launchpad === launchpad)
    .filter((t) => !needle || `${t.name} ${t.symbol} $${t.symbol} ${t.address} ${t.market}`.toLowerCase().includes(needle))
    .sort((a, b) => {
      const x = value[sort.key](a);
      const y = value[sort.key](b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.createdAt - a.createdAt;
    });
  useFlip(body, rows.map((t) => t.address).join());

  if (!q.data) return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Tokens" /> : <Loading label="tokens" height={56} count={5} />;

  const count = (s: StatusFilter) => (s === 'all' ? tokens.length : tokens.filter((t) => t.status === s).length);
  const statusOptions = (['all', 'active', 'pending', 'paused'] as const).map((s) => ({ value: s, label: `${s === 'all' ? 'All' : s[0]?.toUpperCase() + s.slice(1)} ${count(s)}` }));
  const traded = tokens.some((t) => t.book.trades > 0);
  const filtered = needle !== '' || status !== 'all' || strategy !== 'all' || launchpad !== 'all';
  const onSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: k === 'name' ? 1 : -1 }));
  const clear = () => {
    setSearch('');
    setStatus('all');
    setStrategy('all');
    setLaunchpad('all');
  };

  return (
    <div className="tokens">
      <div className="ttools" role="search">
        <label className="search ttools__search">
          <Icon name="search" />
          <span className="sr-only">Search tokens</span>
          <input ref={searchRef} className="input" type="search" placeholder="Search name, ticker, address or market" value={search} onChange={(e) => setSearch(e.target.value)} />
          <kbd className="ttools__kbd" aria-hidden="true">
            /
          </kbd>
        </label>
        <div className="ttools__filters">
          <Segmented label="Status" size="sm" options={statusOptions} value={status} onChange={setStatus} />
          <select className="select ttools__select" value={strategy} onChange={(e) => setStrategy(e.target.value as StrategyId | 'all')} aria-label="Strategy">
            <option value="all">Every strategy</option>
            {STRATEGY_IDS.map((id) => (
              <option key={id} value={id}>
                {STRATEGIES[id].label}
              </option>
            ))}
          </select>
          <select className="select ttools__select" value={launchpad} onChange={(e) => setLaunchpad(e.target.value as LaunchpadId | 'all')} aria-label="Launchpad">
            <option value="all">Every launchpad</option>
            {LAUNCHPAD_IDS.map((id) => (
              <option key={id} value={id}>
                {LAUNCHPADS[id].name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />

      {tokens.length === 0 ? (
        <Empty
          title="No tokens yet"
          action={
            <Link to="/launch" className="btn btn--primary btn--sm">
              Launch the first one
            </Link>
          }
        >
          Tokens appear here the moment they’re registered, including ones waiting for review.
        </Empty>
      ) : rows.length === 0 ? (
        <Empty
          title="Nothing matches"
          action={
            <button type="button" className="btn btn--secondary btn--sm" onClick={clear}>
              Clear search and filters
            </button>
          }
        >
          No token matches {needle ? `“${search.trim()}”` : 'these filters'}.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table xtable xtable--lg ttable table--click">
            <caption className="sr-only">
              Registered tokens, sorted by {SORT_LABEL[sort.key]} ({sort.dir === 1 ? 'ascending' : 'descending'})
            </caption>
            <thead>
              <tr>
                <SortHeader k="name" label="Token" sort={sort} onSort={onSort} align="l" />
                <th scope="col">Market</th>
                <SortHeader k="fees" label="Fees" sort={sort} onSort={onSort} />
                <SortHeader k="burned" label="Burned" sort={sort} onSort={onSort} />
                {traded && <SortHeader k="pnl" label="PnL" sort={sort} onSort={onSort} />}
                <th scope="col" className="ttable__call-h">
                  The engine’s call
                </th>
                <SortHeader k="ring" label="Last burn" sort={sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody ref={body}>
              {rows.map((t) => {
                const ring = lastRing.get(t.address.toLowerCase());
                return (
                  <tr key={t.address} data-flip={t.address} onClick={(e) => !(e.target as HTMLElement).closest('a, button') && navigate(`/t/${t.address}`)}>
                    <td className="xtable__d">
                      <Identity t={t} />
                    </td>
                    <td className="xtable__d">
                      <span className="ttable__mkt num">{t.market}</span>
                      <span className="ttable__strat">{strategyLine(t)}</span>
                    </td>
                    <td className="xtable__d r num">{eth(t.book.feesClaimedEth)}</td>
                    <td className="xtable__d r">
                      <span className="num">{burnedPct(t.book.supplyBurnedPct)}</span>
                      <span className="ttable__sub num">{t.book.tokensBurned > 0 ? compact(t.book.tokensBurned) : 'none yet'}</span>
                    </td>
                    {traded && (
                      <td className="xtable__d r">{t.book.trades > 0 || t.book.unrealizedPnlUsd !== 0 ? <Pnl value={t.book.realizedPnlUsd + t.book.unrealizedPnlUsd} /> : <span className="muted">—</span>}</td>
                    )}
                    <td className="xtable__d ttable__call">
                      {!statusSaysIt(t) && <VerdictPill verdict={t.decision.verdict} />}
                      <span className="ttable__msg" title={t.decision.message}>
                        {t.decision.message}
                      </span>
                    </td>
                    <td className="xtable__d r num ttable__ring">
                      {ring ? (
                        <time dateTime={new Date(ring).toISOString()} title={etDateTime(ring)}>
                          {relTime(Math.min(ring, now), now)}
                        </time>
                      ) : (
                        <span className="muted">{t.book.buybackEth > 0 ? 'earlier' : 'none yet'}</span>
                      )}
                      <Icon name="arrowRight" size={14} className="ttable__go" />
                    </td>
                    <td className="xtable__m">
                      <span className="xtable__line">
                        <Identity t={t} />
                        <span className="ttable__m-burn">
                          <span className="num">{burnedPct(t.book.supplyBurnedPct)}</span>
                          <span className="ttable__sub">burned</span>
                        </span>
                      </span>
                      <span className="xtable__sub dots">
                        {!statusSaysIt(t) && <VerdictPill verdict={t.decision.verdict} />}
                        <span className="num">{t.market}</span>
                        {t.decision.verdict !== 'burn-only' && <span>{strategyLine(t)}</span>}
                        <span className="num">{eth(t.book.feesClaimedEth)} fees</span>
                      </span>
                      <span className="ttable__m-msg">{t.decision.message}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="tokens__count">
        {filtered ? `Showing ${rows.length} of ${tokens.length} tokens.` : `${tokens.length} ${tokens.length === 1 ? 'token' : 'tokens'}.`} Rejected and retired tokens are listed only on their own pages.
        {filtered && rows.length > 0 && (
          <>
            {' '}
            <button type="button" className="link-btn" onClick={clear}>
              Clear filters
            </button>
          </>
        )}
      </p>
    </div>
  );
}
