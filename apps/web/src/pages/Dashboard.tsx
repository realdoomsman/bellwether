import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { LiveActivity } from '../components/ActivityFeed';
import { Empty, EngineDark, ErrorNotice, Loading, StaleNote } from '../components/DataState';
import { TradesTable } from '../components/TradesTable';
import { useTitle } from '../lib/hooks';
import { usePaperMode, useStatus, useTrades } from '../lib/queries';
import '../styles/dashboard.css';
import { Ledger } from './dashboard/Ledger';
import { LiveHead } from './dashboard/LiveHead';
import { OpenPositions } from './dashboard/OpenPositions';
import { TokensTable } from './dashboard/TokensTable';

function Trades() {
  const q = useTrades();
  const paper = usePaperMode();
  if (!q.data) return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Trades" compact /> : <Loading label="trades" height={44} count={4} />;
  if (q.data.trades.length === 0) {
    return <Empty title="No trades yet.">Every open, take-profit, stop and close lands here with the engine’s reason for it.</Empty>;
  }
  return (
    <>
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
      <TradesTable trades={q.data.trades} limit={10} caption={`The latest ${q.data.trades.length} pooled trades, newest first${paper ? ', simulated in paper mode' : ''}`} />
    </>
  );
}

/** /app, "Live": the engine's status and books, open positions beside the activity, then every token and trade. */
export default function Dashboard() {
  useTitle('Live');
  const status = useStatus();
  const paper = usePaperMode();
  const { hash } = useLocation();

  // The tape's "Recent activity" link lands on #activity.
  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash]);

  const dark = !status.data && status.error?.offline;

  return (
    <div className="container page live">
      <LiveHead />

      {dark ? (
        <EngineDark>
          <Link to="/docs" className="btn btn--secondary btn--sm">
            Read how it works
          </Link>
        </EngineDark>
      ) : (
        <>
          <Ledger />

          <div className="live-body">
            <section className="live-positions" aria-labelledby="positions-title">
              <OpenPositions titleId="positions-title" />
            </section>
            <section id="activity" className="live-activity" aria-labelledby="activity-title">
              <LiveActivity titleId="activity-title" />
            </section>
          </div>

          <section className="live-section" aria-labelledby="tokens-title">
            <div className="panel-head">
              <h2 id="tokens-title" className="panel-head__title">
                Tokens
              </h2>
              <p className="panel-head__note">Every registered token and what the engine is doing with it right now.</p>
            </div>
            <TokensTable />
          </section>

          <section className="live-section" aria-labelledby="trades-title">
            <div className="panel-head">
              <h2 id="trades-title" className="panel-head__title">
                Trades
              </h2>
              <p className="panel-head__note">
                Pooled per market; each trade is split across the tokens sharing the position.
                {paper && <span className="paper-tag">PAPER</span>}
              </p>
            </div>
            <Trades />
          </section>
        </>
      )}
    </div>
  );
}
