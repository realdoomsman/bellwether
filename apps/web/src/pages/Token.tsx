import { BRAND, STRATEGIES, type TokenDetailResponse } from '@bellwether/shared';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { TokenTimeline } from '../components/ActivityFeed';
import { Empty, ErrorNotice, StaleNote } from '../components/DataState';
import { figureStatus } from '../components/Figure';
import { Icon } from '../components/Icon';
import { Medallion } from '../components/Medallion';
import { Pnl } from '../components/Stat';
import { TradesTable } from '../components/TradesTable';
import { isAddress } from '../lib/api';
import { pct, shortAddr, usd } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { usePaperMode, usePositions, useToken, useTokens } from '../lib/queries';
import '../styles/token.css';
import NotFound from './NotFound';
import { PositionTable } from './dashboard/Positions';
import { Book } from './token/Book';
import { BurnFigure } from './token/BurnFigure';
import { Charts } from './token/Charts';
import { CreatorSettings } from './token/CreatorSettings';
import { EngineCall } from './token/EngineCall';
import { TokenHeader, TokenStatusLine } from './token/TokenHeader';

type Detail = TokenDetailResponse;

/** This token's share of the pooled position for its market, expanded to the exit ladder. */
function Position({ d }: { d: Detail }) {
  const live = usePositions().data;
  const t = d.token;
  const address = t.address.toLowerCase();
  // The pooled list streams every few seconds; once loaded, a token missing from it is out of
  // position even if the slower token detail still shows the old one.
  const position = live ? (live.positions.find((p) => p.shares.some((s) => s.token.toLowerCase() === address)) ?? null) : d.position;
  const share = position?.shares.find((s) => s.token.toLowerCase() === address);
  // Burn-only tokens never trade; the section appears only if one still holds a position from before.
  if (!position && !STRATEGIES[t.strategy].trades) return null;
  return (
    <section className="tkn-section" aria-labelledby="pos-title">
      <div className="panel-head">
        <h2 id="pos-title" className="panel-head__title">
          Position
        </h2>
        {position && share && (
          <p className="panel-head__sum">
            <span>
              ${t.symbol} owns <span className="num">{pct(share.share)}</span>
            </span>
            <span>
              <span className="num">{usd(share.collateralUsd)}</span> margin
            </span>
            <span>
              open <Pnl value={position.unrealizedPnlUsd * share.share} />
            </span>
          </p>
        )}
      </div>
      {position ? (
        <PositionTable positions={[position]} focusToken={t.address} openByDefault caption={`The pooled ${position.market} position ${t.symbol} shares, with its exit ladder`} />
      ) : (
        <Empty title="Not in a position.">{t.decision.message}</Empty>
      )}
    </section>
  );
}

/**
 * Loading: the header and the lead at their final size with dashes. The page holds a full viewport
 * meanwhile, so the footer never shows and then jumps away when the token arrives.
 */
function TokenPending({ address, error, onRetry }: { address: string; error?: Parameters<typeof ErrorNotice>[0]['error']; onRetry: () => void }) {
  return (
    <div className="container page tkn" aria-busy={!error}>
      <header className="tkn-head">
        <Medallion image={null} symbol="?" address={address} size={72} className="tkn-head__medal is-waiting" />
        <div className="tkn-head__id">
          <h1 className="tkn-head__name muted">—</h1>
          <p className="tkn-head__facts dots">
            <span className="num">{shortAddr(address)}</span>
            <span role="status">{error ? 'Couldn’t load this token' : 'Connecting to the engine…'}</span>
          </p>
        </div>
      </header>
      {error ? (
        <ErrorNotice error={error} onRetry={onRetry} what="This token" />
      ) : (
        <div className="tkn-lead" aria-hidden="true">
          <div className="tkn-burn">
            <div className="tkn-burn__top">
              <p className="tkn-label">Supply burned</p>
            </div>
            <p className="tkn-burn__fig muted">—</p>
          </div>
          <div className="tkn-call">
            <p className="tkn-label">The engine’s call right now</p>
            <p className="tkn-call__quote muted">—</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Find a registered token by name, ticker or address, or jump straight to an address. */
function TokenLookup() {
  const tokens = useTokens().data?.tokens ?? [];
  const navigate = useNavigate();
  const id = useId();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const address = isAddress(q.trim());
  const hits = needle ? tokens.filter((t) => `${t.name} ${t.symbol} $${t.symbol} ${t.address}`.toLowerCase().includes(needle)).slice(0, 5) : [];
  const result = !needle || address ? '' : hits.length === 0 ? `No registered token matches “${q.trim()}”.` : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`;
  return (
    <form
      className="tkn-lookup field"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const value = q.trim();
        if (isAddress(value)) navigate(`/t/${value}`);
        else if (hits[0]) navigate(`/t/${hits[0].address}`);
      }}
    >
      <label className="field__label" htmlFor={id}>
        Or find a registered token
      </label>
      <div className="search">
        <Icon name="search" />
        <input id={id} className="input" type="search" placeholder="Name, ticker or 0x address" autoComplete="off" spellCheck={false} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className={hits.length > 0 ? 'sr-only' : 'field__hint'} role="status">
        {result}
      </p>
      {hits.length > 0 && (
        <ul className="tkn-lookup__hits">
          {hits.map((t) => (
            <li key={t.address}>
              <Link to={`/t/${t.address}`} className="tok">
                <Medallion image={t.image} symbol={t.symbol} address={t.address} size={28} />
                <span className="tok__id">
                  <span className="tok__name">{t.name}</span>
                  <span className="tok__sym num">${t.symbol}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function NotRegistered({ address }: { address: string }) {
  return (
    <div className="container page tkn tkn--missing">
      <p className="tkn-label">Token</p>
      <h1 className="tkn-missing__title">
        No token at {shortAddr(address)}
      </h1>
      <p className="lead">
        {BRAND.name} has no ledger for <code className="num break">{address}</code>. If you just launched it, register it in the last step of the launch wizard; otherwise check the address.
      </p>
      <div className="row tkn-missing__actions">
        <Link to="/launch" className="btn btn--primary">
          Register it
        </Link>
        <Link to="/app" className="btn btn--secondary">
          See the tokens that are live
        </Link>
      </div>
      <TokenLookup />
    </div>
  );
}

function TokenBody({ address }: { address: string }) {
  const q = useToken(address);
  const paper = usePaperMode();
  useTitle(q.data ? `$${q.data.token.symbol} · ${q.data.token.name}` : q.error?.code === 'not_found' ? 'Token not registered' : 'Token');

  if (!q.data) {
    if (q.error?.code === 'not_found') return <NotRegistered address={address} />;
    return <TokenPending address={address} error={q.error} onRetry={q.refresh} />;
  }

  const d = q.data;
  const t = d.token;
  const traded = STRATEGIES[t.strategy].trades || d.trades.length > 0;
  return (
    <div className="container page tkn">
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
      <TokenHeader t={t} asOf={q.updatedAt} />
      <TokenStatusLine t={t} />

      <div className="tkn-lead">
        <BurnFigure t={t} activity={d.activity} asOf={q.updatedAt} status={figureStatus(q)} onRetry={q.refresh} paper={paper} />
        <EngineCall t={t} />
      </div>

      <section className="tkn-section" aria-labelledby="book-title">
        <div className="panel-head">
          <h2 id="book-title" className="panel-head__title">
            Book
          </h2>
          <p className="panel-head__note">Everything the engine holds and has done for ${t.symbol}, from its ledger.</p>
        </div>
        <Book t={t} paper={paper} />
      </section>

      <Position d={d} />

      <section className="tkn-section" aria-labelledby="charts-title">
        <Charts
          address={t.address}
          symbol={t.symbol}
          market={t.market}
          side={t.side}
          priceUsd={t.priceUsd}
          change24hPct={t.change24hPct}
          activity={d.activity}
          trades={traded ? d.trades : null}
          titleId="charts-title"
        />
      </section>

      {traded && (
        <section className="tkn-section" aria-labelledby="trades-title">
          <div className="panel-head">
            <h2 id="trades-title" className="panel-head__title">
              Trades
            </h2>
            <p className="panel-head__note">
              Trades on the pooled position ${t.symbol} shares; its part is its share of each.
              {paper && <span className="paper-tag">PAPER</span>}
            </p>
          </div>
          {d.trades.length === 0 ? (
            <Empty title="No trades yet.">Every open, take-profit, stop and close lands here with the engine’s reason for it.</Empty>
          ) : (
            <TradesTable trades={d.trades} limit={10} caption={`Trades for ${t.symbol}’s share of pooled positions, newest first`} />
          )}
        </section>
      )}

      <section className="tkn-section" aria-labelledby="activity-title">
        <TokenTimeline token={t.address} symbol={t.symbol} events={d.activity} titleId="activity-title" />
      </section>

      <CreatorSettings token={t} />
    </div>
  );
}

export default function Token() {
  const { address = '' } = useParams();
  if (!isAddress(address)) return <NotFound />;
  // Keyed so local state (chart tab, settings form) resets when navigating between tokens.
  return <TokenBody key={address.toLowerCase()} address={address} />;
}
