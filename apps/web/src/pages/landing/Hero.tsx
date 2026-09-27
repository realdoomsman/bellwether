import { BRAND, CHAINS, LAUNCHPADS } from '@bellwether/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Bell } from '../../components/Bell';
import { CopyButton } from '../../components/CopyButton';
import { figureStatus } from '../../components/Figure';
import { Arrow } from '../../components/Primitives';
import { RollingNumber } from '../../components/RollingNumber';
import { etTime, shortAddr } from '../../lib/format';
import { usePaperMode, useStats, useStatus } from '../../lib/queries';

/** The headline rises in once per visit, not on every return to the page. */
let entered = false;

/** "Burned by the engine: $4.57 · as of 05:50:35 ET": the one live figure above the headline. */
function LiveLine() {
  const q = useStats();
  const paper = usePaperMode();
  const state = figureStatus(q);
  const usd = q.data?.burnedUsd;
  // Before the first buyback a "$0.00" headline figure means nothing; say what happens next instead.
  if (q.data && q.data.buybackCount === 0) {
    return (
      <p className="ld-hero__live" data-status={state}>
        <span className="ld-hero__live-label">Burned by the engine</span>
        <span className="ld-hero__live-meta">nothing yet · the first burn follows the first claimed fee</span>
      </p>
    );
  }
  return (
    <p className="ld-hero__live" data-status={state}>
      <span className="ld-hero__live-label">Burned by the engine</span>
      <strong className="ld-hero__live-fig">
        {usd === undefined ? '—' : <RollingNumber value={usd} format={{ style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }} />}
      </strong>
      {paper && usd !== undefined && <span className="paper-tag">PAPER</span>}
      <span className="ld-hero__live-meta">
        {state === 'loading' && 'Connecting to the engine…'}
        {state === 'offline' && `Engine unreachable${q.updatedAt ? ` · last update ${etTime(q.updatedAt)}` : ''}`}
        {(state === 'live' || state === 'stale') && q.updatedAt !== null && (
          <>
            as of{' '}
            <time dateTime={new Date(q.updatedAt).toISOString()}>{etTime(q.updatedAt, { seconds: true })}</time>
            {state === 'stale' && ' (stale)'}
          </>
        )}
      </span>
      <Link to="/proof" className="ld-hero__live-src">
        Proof
      </Link>
    </p>
  );
}

/** The protocol token's contract, once the operator has configured it (impostors use the name too). */
function ProtocolToken() {
  const token = useStatus().data?.protocolToken;
  if (!token) return null;
  return (
    <p className="ld-hero__token">
      <span className="label">${BRAND.ticker} contract</span>
      <code className="num">{shortAddr(token, 6, 4)}</code>
      <CopyButton text={token} what={`$${BRAND.ticker} contract address`} iconOnly className="icon-btn icon-btn--sm" />
    </p>
  );
}

export function Hero() {
  const [enter] = useState(() => !entered);
  useEffect(() => {
    entered = true;
  }, []);

  return (
    <section className="ld-hero" aria-labelledby="hero-title" data-enter={enter || undefined}>
      <div className="container ld-hero__grid">
        <div className="ld-hero__copy">
          <LiveLine />
          <p className="ld-hero__kicker ld-hero__rise">
            On {CHAINS.rhc.name} · trades US-stock perps on {CHAINS.hyperliquid.name}
          </p>
          <h1 id="hero-title" className="display ld-hero__title">
            <span className="ld-hero__line">Every fee</span> <span className="ld-hero__line">rings the bell.</span>
          </h1>
          <p className="lead ld-hero__lead ld-hero__rise">
            Launch on {LAUNCHPADS.pons.name} or {LAUNCHPADS.launchhood.name} with {BRAND.name} as your fee recipient. The engine claims your fees, trades tokenized-stock perps, and buys back and burns your token,
            every step with a receipt.
          </p>
          <div className="ld-hero__actions ld-hero__rise">
            <Link to="/launch" className="btn btn--primary btn--lg">
              Launch a token
            </Link>
            <Link to="/app" className="tertiary">
              <Arrow>Watch the engine live</Arrow>
            </Link>
          </div>
          <ProtocolToken />
        </div>
        <div className="ld-hero__bell">
          <Bell settle={enter} />
        </div>
      </div>
    </section>
  );
}
