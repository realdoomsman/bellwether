import { SESSION_LABEL } from '@floor/shared';
import { Link } from 'react-router';
import { LiveActivity } from '../components/ActivityFeed';
import { Empty, EngineDark, ErrorNotice, Loading, StaleNote } from '../components/DataState';
import { EngineStatusBar, WorkerList } from '../components/EngineStatus';
import { PositionCard } from '../components/PositionCard';
import { Pnl, Stat } from '../components/Stat';
import { eth, int, pct0, usd } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { usePositions, useStats, useStatus } from '../lib/queries';
import '../styles/dashboard.css';
import { TokensTable } from './dashboard/TokensTable';

function Kpis() {
  const q = useStats();
  if (!q.data) return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Protocol stats" compact /> : <Loading label="protocol stats" height={86} />;
  const s = q.data;
  const closed = s.wins + s.losses;
  return (
    <>
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
      <dl className="stats">
        <Stat label="Burned (USD at burn)" value={usd(s.burnedUsd, { compact: true })} led sub={`${eth(s.buybackEth)} · ${int(s.buybackCount)} buybacks`} />
        <Stat label="Fees claimed" value={eth(s.feesClaimedEth)} sub="all time" />
        <Stat label="Realized PnL" value={<Pnl value={s.realizedPnlUsd} compact />} sub={<>open <Pnl value={s.unrealizedPnlUsd} compact /></>} />
        <Stat label="Trading equity" value={usd(s.tradingEquityUsd, { compact: true })} sub={`${int(s.openPositions)} open position${s.openPositions === 1 ? '' : 's'}`} />
        <Stat label="Tokens" value={int(s.tokensActive)} sub={s.tokensPending > 0 ? `+${int(s.tokensPending)} pending review` : 'active'} />
        <Stat label="Trades" value={int(s.trades)} sub={closed > 0 ? `${pct0(s.wins / closed)} win rate (${s.wins}W / ${s.losses}L)` : 'no closed trades yet'} />
        <Stat label="$FLOOR burned" value={int(s.floorBurned)} sub="tokens" />
        <Stat label="Buybacks" value={int(s.buybackCount)} sub={eth(s.buybackEth)} />
      </dl>
    </>
  );
}

function Positions() {
  const q = usePositions();
  const session = useStatus().data?.session;
  if (!q.data) return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Positions" /> : <Loading label="positions" height={260} />;
  if (q.data.positions.length === 0) {
    return (
      <Empty title="No open positions" icon="steps">
        The engine is flat right now{session ? ` (${SESSION_LABEL[session].toLowerCase()})` : ''}. Each token’s row below says exactly why it isn’t trading.
      </Empty>
    );
  }
  return (
    <>
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
      <div className="positions">
        {q.data.positions.map((p) => (
          <PositionCard key={p.id} position={p} />
        ))}
      </div>
    </>
  );
}

export default function Dashboard() {
  useTitle('App');
  const status = useStatus();

  return (
    <div className="container page dash">
      <header className="page-head">
        <div>
          <p className="page-head__eyebrow">App</p>
          <h1>The floor, live</h1>
          <p>Every claim, trade and burn the engine makes, as it makes them.</p>
        </div>
        <Link to="/launch" className="btn btn--primary">
          Launch a token
        </Link>
      </header>

      <EngineStatusBar />

      {!status.data && status.error ? (
        <div className="block">
          <EngineDark>
            <Link to="/docs" className="btn btn--ghost btn--sm">
              Read how it works
            </Link>
            <Link to="/launch" className="btn btn--ghost btn--sm">
              Plan a launch
            </Link>
          </EngineDark>
        </div>
      ) : (
        <>
          <section className="block" aria-labelledby="kpi-title">
            <h2 id="kpi-title" className="sr-only">
              Protocol totals
            </h2>
            <Kpis />
          </section>

          <section className="block" aria-labelledby="pos-title">
            <div className="block-head">
              <h2 id="pos-title">Open positions</h2>
              <p className="muted small">Positions are pooled per market; each token owns a share.</p>
            </div>
            <Positions />
          </section>

          <div className="dash__grid block">
            <section aria-labelledby="tok-title" className="dash__tokens">
              <div className="block-head">
                <h2 id="tok-title">Tokens</h2>
              </div>
              <TokensTable />
            </section>
            <section aria-labelledby="act-title" className="dash__activity">
              <div className="block-head">
                <h2 id="act-title">Activity</h2>
              </div>
              <LiveActivity />
            </section>
          </div>
        </>
      )}

      {status.data && status.data.workers.length > 0 && (
        <details className="block workers-panel">
          <summary>
            <span className="panel-label">Engine workers</span>
            <span className="muted small"> · version {status.data.version}</span>
          </summary>
          <WorkerList status={status.data} />
        </details>
      )}
    </div>
  );
}
