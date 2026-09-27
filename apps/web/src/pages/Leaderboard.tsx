import { STRATEGIES, type LeaderboardBy, type LeaderboardResponse } from '@bellwether/shared';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Empty, ErrorNotice, StaleNote } from '../components/DataState';
import { Medallion } from '../components/Medallion';
import { Muted } from '../components/Primitives';
import { Segmented } from '../components/Segmented';
import { Sparkline, SPARK_MIN_POINTS } from '../components/Sparkline';
import { API_BASE } from '../lib/api';
import { compact, etDateTime, etTime, eth, int, pct, relTime, usd } from '../lib/format';
import { useNow, useTitle } from '../lib/hooks';
import { useConfig, useLeaderboard, usePaperMode } from '../lib/queries';
import { onActivity } from '../lib/stream';
import { revalidate } from '../lib/useApi';
import { useRings, type RingIndex } from './leaderboard/rings';
import { useFlip } from './leaderboard/useFlip';
import '../styles/leaderboard.css';

const TABS = [
  { value: 'burned', label: 'Most burned' },
  { value: 'pnl', label: 'Best PnL' },
  { value: 'fees', label: 'Most fees' },
] as const satisfies readonly { value: LeaderboardBy; label: string }[];

const METRIC: Record<LeaderboardBy, { head: string; caption: string }> = {
  burned: { head: 'Supply burned', caption: 'share of total supply burned' },
  pnl: { head: 'Realized PnL', caption: 'realized trading PnL' },
  fees: { head: 'Fees claimed', caption: 'creator fees claimed' },
};

type Row = LeaderboardResponse['rows'][number];

function isBy(v: string | null): v is LeaderboardBy {
  return v === 'burned' || v === 'pnl' || v === 'fees';
}

/** Tiny shares keep a third decimal so neighbours don't all read 0.01%. */
const share = (f: number) => pct(f, { digits: f > 0 && f < 0.001 ? 3 : 2 });

function primaryValue(by: LeaderboardBy, r: Row): number {
  const b = r.book;
  return by === 'burned' ? b.supplyBurnedPct : by === 'pnl' ? b.realizedPnlUsd : b.feesClaimedEth;
}

function Primary({ by, row, scale, paper }: { by: LeaderboardBy; row: Row; scale: number; paper: boolean }) {
  const v = primaryValue(by, row);
  let text: ReactNode;
  if (by === 'burned') text = share(v);
  else if (by === 'fees') text = eth(v);
  else {
    const s = usd(v, { signed: true });
    const dir = s.startsWith('+') ? 'up' : s.startsWith('−') ? 'down' : '';
    text = (
      <span className={dir}>
        {dir && <span aria-hidden="true">{dir === 'up' ? '▲ ' : '▼ '}</span>}
        {s}
      </span>
    );
  }
  const width = scale > 0 ? Math.min(1, Math.abs(v) / scale) : 0;
  return (
    <span className="lb-metric">
      <span className="lb-metric__value num">
        {text}
        {paper && v !== 0 && <span className="paper-tag">PAPER</span>}
      </span>
      <span className="lb-metric__bar" aria-hidden="true">
        <span className={`lb-metric__fill${v < 0 ? ' lb-metric__fill--down' : ''}`} style={{ '--w': width } as CSSProperties} />
      </span>
    </span>
  );
}

function secondary(by: LeaderboardBy, r: Row): string {
  const b = r.book;
  if (by === 'burned') return b.tokensBurned > 0 ? `${compact(b.tokensBurned)} tokens · ${eth(b.buybackEth)}` : 'Nothing burned yet';
  if (by === 'fees') return b.buybackEth > 0 ? `${eth(b.buybackEth)} spent on burns` : 'No burns yet';
  const open = b.unrealizedPnlUsd !== 0 ? `open position ${usd(b.unrealizedPnlUsd, { signed: true })}` : null;
  if (b.trades === 0) return open ? `No closed trades · ${open}` : 'No trades yet';
  return [`${int(b.trades)} closed · ${int(b.wins)} won`, open].filter(Boolean).join(' · ');
}

/** Last buyback, honest about how far back the activity scan reached. */
function LastRing({ row, rings, now }: { row: Row; rings: RingIndex | undefined; now: number }) {
  const at = rings?.last[row.address.toLowerCase()];
  // The ring seen when the index first loaded; only later rings flash.
  const first = useRef<number | null>(null);
  if (!rings) return <span className="muted">—</span>;
  first.current ??= at ?? 0;
  if (at) {
    return (
      <time key={at} dateTime={new Date(at).toISOString()} title={etDateTime(at)} className={at !== first.current ? 'lb-ring lb-ring--fresh' : 'lb-ring'}>
        {relTime(at, now)}
      </time>
    );
  }
  if (row.book.buybackEth === 0) return <span className="muted">Not yet</span>;
  if (!rings.complete && rings.scannedFrom) {
    const when = relTime(rings.scannedFrom, now);
    return <span className="muted">{when.endsWith('ago') ? `Over ${when}` : `Before ${when}`}</span>;
  }
  return <span className="muted">—</span>;
}

function Lead({ by, row, paper }: { by: LeaderboardBy; row: Row; paper: boolean }) {
  const v = primaryValue(by, row);
  if (v <= 0) return null;
  const tag = paper ? <span className="paper-tag">PAPER</span> : null;
  return (
    <p className="lb-lead">
      <Medallion image={row.image} symbol={row.symbol} address={row.address} size={44} />
      <span>
        <Link to={`/t/${row.address}`}>{row.name}</Link>{' '}
        {by === 'burned' ? (
          <>
            leads. <Muted>{share(v)} of its supply is gone for good{tag}.</Muted>
          </>
        ) : by === 'fees' ? (
          <>
            leads. <Muted>{eth(v)} in creator fees claimed{tag}.</Muted>
          </>
        ) : (
          <>
            leads. <Muted>{usd(v, { signed: true })} realized from trading{tag}.</Muted>
          </>
        )}
      </span>
    </p>
  );
}

export default function Leaderboard() {
  useTitle('The bellwethers');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get('by');
  const by: LeaderboardBy = isBy(raw) ? raw : 'burned';
  const q = useLeaderboard(by);
  const rings = useRings().data;
  const paper = usePaperMode();
  const minCollateral = useConfig().data?.minCollateralUsd;
  const now = useNow(15_000);
  const table = useRef<HTMLTableSectionElement>(null);

  // Keep the last standings on screen while another tab loads, so the rows can re-sort in place.
  const held = useRef<LeaderboardResponse | undefined>(undefined);
  if (q.data) held.current = q.data;
  const data = q.data ?? held.current;
  const shownBy = data?.by ?? by;
  const rows = data?.rows ?? [];
  useFlip(table, `${shownBy}:${rows.map((r) => r.address).join()}`);

  // A burn can change the standings: refetch shortly after one lands (coalescing bursts).
  useEffect(() => {
    let t = 0;
    const off = onActivity((e) => {
      if (e.kind !== 'buyback' && e.kind !== 'claim' && e.kind !== 'close') return;
      window.clearTimeout(t);
      t = window.setTimeout(() => revalidate(`leaderboard:${by}`), 1_500);
    });
    return () => {
      off();
      window.clearTimeout(t);
    };
  }, [by]);

  const scale = Math.max(0, ...rows.map((r) => Math.abs(primaryValue(shownBy, r))));
  const noTrades = shownBy === 'pnl' && rows.every((r) => r.book.trades === 0);
  const openCount = rows.filter((r) => r.book.deployedUsd > 0).length;
  const sparkRows = rings?.coversWindow ? rows.filter((r) => (rings.daily[r.address.toLowerCase()] ?? []).filter((v) => v > 0).length >= SPARK_MIN_POINTS) : [];
  const showSpark = sparkRows.length > 0;
  const loadingTab = q.data === undefined && data !== undefined && data.by !== by;

  return (
    <div className="container lb">
      <header className="lb-head">
        <div className="lb-head__titles">
          <p className="label">Leaderboard</p>
          <h1>The bellwethers</h1>
          <p className="lead">Tokens leading on supply burned, trading PnL and fees, ranked from the engine’s ledger. Burns count as a share of supply, so small caps compete.</p>
        </div>
        <div className="lb-head__controls">
          <Segmented label="Rank by" options={TABS} value={by} onChange={(v) => setParams({ by: v }, { replace: true })} />
          <p className="lb-head__asof small">
            {q.updatedAt ? (
              <>
                As of <time dateTime={new Date(q.updatedAt).toISOString()}>{etTime(q.updatedAt, { seconds: true })}</time>
                {q.stale ? ' (stale)' : ''} · updates on every burn ·{' '}
              </>
            ) : (
              <>{q.error ? 'Engine unreachable' : 'Connecting to the engine…'} · </>
            )}
            <a href={`${API_BASE}/leaderboard?by=${by}`} target="_blank" rel="noopener noreferrer">
              JSON ↗<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </div>
      </header>

      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />

      {!data ? (
        q.error ? (
          <ErrorNotice error={q.error} onRetry={q.refresh} what="The leaderboard" />
        ) : (
          <div className="lb-placeholder" role="status">
            <span className="sr-only">Loading the leaderboard…</span>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="lb-placeholder__row">
                <span className="fig">—</span>
                <span className="muted small">{i === 0 ? 'Connecting to the engine…' : ''}</span>
              </div>
            ))}
          </div>
        )
      ) : rows.length === 0 ? (
        <Empty
          title="No tokens yet. Be the first bellwether."
          action={
            <Link to="/launch" className="btn btn--primary btn--sm">
              Launch a token
            </Link>
          }
        >
          Tokens appear here as soon as they’re registered and their first fees are claimed.
        </Empty>
      ) : noTrades && !loadingTab ? (
        <Empty
          title="No closed trades yet."
          action={
            <Link to="/app" className="btn btn--secondary btn--sm">
              Watch the engine live
            </Link>
          }
        >
          A token starts trading once its book holds {minCollateral !== undefined ? usd(minCollateral) : 'the minimum collateral'}, its strategy’s session is open and the signal clears its threshold. PnL
          rankings appear after the first trade closes.{openCount > 0 && ` ${openCount} token${openCount === 1 ? ' has' : 's have'} an open position right now.`}
        </Empty>
      ) : (
        <>
          <Lead by={shownBy} row={rows[0]!} paper={paper} />
          <div className="table-wrap">
            <table className="table lb-table" aria-busy={loadingTab || undefined}>
              <caption className="sr-only">Tokens ranked by {METRIC[shownBy].caption}. Select a row to open the token.</caption>
              <thead>
                <tr>
                  <th scope="col" className="lb-rank">
                    Rank
                  </th>
                  <th scope="col">Token</th>
                  <th scope="col" className="r">
                    {METRIC[shownBy].head}
                  </th>
                  <th scope="col" className="lb-col-2">
                    Detail
                  </th>
                  <th scope="col" className="lb-col-3">
                    Market · strategy
                  </th>
                  <th scope="col" className="r lb-col-4">
                    Last ring
                  </th>
                  {showSpark && (
                    <th scope="col" className="lb-col-5">
                      Burns, 30 days
                    </th>
                  )}
                </tr>
              </thead>
              <tbody ref={table}>
                {rows.map((r) => {
                  const s = STRATEGIES[r.strategy];
                  return (
                    <tr
                      key={r.address}
                      data-flip={r.address}
                      className={r.rank <= 3 ? 'lb-row lb-row--top' : 'lb-row'}
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest('a')) navigate(`/t/${r.address}`);
                      }}
                    >
                      <td className="lb-rank">
                        <span className="lb-rank__n fig">{r.rank}</span>
                      </td>
                      <th scope="row" className="lb-token">
                        <span className="lb-token__inner">
                          <Medallion image={r.image} symbol={r.symbol} address={r.address} size={r.rank <= 3 ? 40 : 32} />
                          <span className="lb-token__id">
                            <Link to={`/t/${r.address}`} className="lb-token__name">
                              {r.name}
                            </Link>
                            <span className="lb-token__sym num">
                              ${r.symbol}
                              {r.status === 'paused' && <span className="lb-token__note"> · paused</span>}
                            </span>
                          </span>
                        </span>
                      </th>
                      <td className="r lb-primary">
                        <Primary by={shownBy} row={r} scale={scale} paper={paper} />
                      </td>
                      <td className="lb-col-2 small dim">{secondary(shownBy, r)}</td>
                      <td className="lb-col-3 small">{s.trades ? <><span className="num">{r.market}</span> · {s.label}</> : s.label}</td>
                      <td className="r lb-col-4 small num">
                        <LastRing row={r} rings={rings} now={now} />
                      </td>
                      {showSpark && (
                        <td className="lb-col-5">
                          <Sparkline
                            values={rings?.daily[r.address.toLowerCase()] ?? []}
                            label={`$${r.symbol} tokens burned per day, last 30 days`}
                            tone="brass"
                            height={28}
                            fallback="Too few burns to chart"
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="lb-foot small">
            Ranked across active and paused tokens. Pending tokens join once they’re approved. “Last ring” is the latest buyback and burn, read from the public activity log.
          </p>
        </>
      )}
    </div>
  );
}
