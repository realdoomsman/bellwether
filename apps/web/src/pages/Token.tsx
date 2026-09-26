import { addressUrl, BRAND, LAUNCHPADS, STRATEGIES, type TokenDetailResponse, type TradeView } from '@stepup/shared';
import { Link, useParams } from 'react-router';
import { ActivityList } from '../components/ActivityFeed';
import { StatusPill } from '../components/Badges';
import { CopyButton } from '../components/CopyButton';
import { Empty, ErrorNotice, Loading, StaleNote } from '../components/DataState';
import { Decision } from '../components/Decision';
import { Icon } from '../components/Icon';
import { AddressChip, ExtLink } from '../components/Links';
import { PositionCard } from '../components/PositionCard';
import { Change, Pnl, Stat } from '../components/Stat';
import { StepMeter } from '../components/StepMeter';
import { TokenAvatar } from '../components/TokenAvatar';
import { TradesTable } from '../components/TradesTable';
import { eth, int, leverage, pct, price, usd } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { usePositions, useToken } from '../lib/queries';
import '../styles/token.css';
import { isAddress } from '../lib/api';
import NotFound from './NotFound';
import { Charts } from './token/Charts';
import { CreatorSettings } from './token/CreatorSettings';

type Detail = TokenDetailResponse;

function Identity({ d }: { d: Detail }) {
  const t = d.token;
  const s = STRATEGIES[t.strategy];
  const link = `${window.location.origin}/t/${t.address}`;
  const shareText = `$${t.symbol} keeps stepping up on ${BRAND.name}: ${pct(t.book.supplyBurnedPct, { digits: 2 })} of supply burned so far.`;
  return (
    <header className="tid">
      <TokenAvatar image={t.image} symbol={t.symbol} size={64} />
      <div className="tid__main">
        <div className="row">
          <h1 className="tid__name">{t.name}</h1>
          <StatusPill status={t.status} />
        </div>
        <p className="tid__meta">
          <span className="num amber">${t.symbol}</span>
          <span>{LAUNCHPADS[t.launchpad].name}</span>
          <span className="num">
            {t.market} · {t.side === 'long' ? 'long' : 'short'}
            {s.trades ? ` · ≤${leverage(t.maxLeverage)}` : ''}
          </span>
          <span>{s.label}</span>
          {t.priceUsd !== null && (
            <span className="num">
              {price(t.priceUsd)}{' '}
              {t.change24hPct !== null && <Change frac={t.change24hPct} />}
            </span>
          )}
        </p>
        <AddressChip address={t.address} what="token address" />
      </div>
      <div className="tid__actions">
        <CopyButton text={link} what="token page link" label="Copy link" />
        <a className="btn btn--ghost btn--sm" href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(link)}`} target="_blank" rel="noopener noreferrer">
          <Icon name="share" /> Share
        </a>
        <ExtLink href={addressUrl('rhc', t.address)} className="btn btn--ghost btn--sm">
          Explorer
        </ExtLink>
      </div>
    </header>
  );
}

function StatusNote({ d }: { d: Detail }) {
  const t = d.token;
  if (t.status === 'rejected') {
    return (
      <p className="callout" role="status">
        <Icon name="warn" /> <strong>Rejected.</strong> {t.rejectedReason ?? 'No reason was recorded.'} The engine does not claim fees or trade for this token.
      </p>
    );
  }
  if (t.status === 'pending') {
    return (
      <p className="tnote tnote--pending" role="status">
        <strong>Pending review.</strong> This token is registered and waiting for approval. Fees accrue on the launchpad in the meantime; nothing is claimed or traded until it’s approved.
      </p>
    );
  }
  if (t.status === 'paused' || t.status === 'retired') {
    return (
      <p className="tnote" role="status">
        <strong>{t.status === 'paused' ? 'Paused.' : 'Retired.'}</strong> The engine isn’t opening new positions or buying back for this token.
      </p>
    );
  }
  return null;
}

function Book({ d }: { d: Detail }) {
  const b = d.token.book;
  return (
    <dl className="stats book">
      <Stat label="Fees claimed" value={eth(b.feesClaimedEth)} />
      <Stat label="Realized PnL" value={<Pnl value={b.realizedPnlUsd} />} sub={<>open <Pnl value={b.unrealizedPnlUsd} /></>} />
      <Stat label="In a position" value={usd(b.deployedUsd)} sub="collateral deployed" />
      <Stat label="Trades" value={int(b.trades)} sub={b.trades > 0 ? `${int(b.wins)} won` : 'none yet'} />
      <Stat label="Trading budget" value={usd(b.tradingBudgetUsd)} sub="unspent, waiting for entry" />
      <Stat label="Token burn budget" value={eth(b.tokenBuybackBudgetEth)} sub="queued for the next buyback" />
      <Stat label={`$${BRAND.ticker} burn budget`} value={eth(b.protocolBuybackBudgetEth)} sub="queued" />
      <Stat label="Spent on buybacks" value={eth(b.buybackEth)} />
    </dl>
  );
}

function PositionShare({ d }: { d: Detail }) {
  const live = usePositions().data;
  const address = d.token.address.toLowerCase();
  // The pooled list refreshes every few seconds over the stream; once it has loaded, a token missing
  // from it is out of position even if the slower token detail still shows the old one.
  const position = live ? (live.positions.find((p) => p.shares.some((s) => s.token.toLowerCase() === address)) ?? null) : d.position;
  const share = position?.shares.find((s) => s.token.toLowerCase() === address);
  return (
    <section className="block" aria-labelledby="pos-title">
      <div className="block-head">
        <h2 id="pos-title">Position</h2>
        {position && share && (
          <p className="dim small">
            ${d.token.symbol} owns <strong className="num">{pct(share.share)}</strong> ({usd(share.collateralUsd)} collateral) · attributable open PnL <Pnl value={position.unrealizedPnlUsd * share.share} />
          </p>
        )}
      </div>
      {position ? (
        <PositionCard position={position} focusToken={d.token.address} />
      ) : (
        <Empty title="Not in a position" icon="steps">
          The engine’s current decision above explains why. Fees keep burning either way.
        </Empty>
      )}
    </section>
  );
}

function Trades({ trades }: { trades: TradeView[] }) {
  return (
    <section className="block" aria-labelledby="trades-title">
      <div className="block-head">
        <h2 id="trades-title">Trades</h2>
      </div>
      {trades.length === 0 ? (
        <Empty title="No trades yet" icon="steps">
          Trades appear here with the engine’s reason for each one.
        </Empty>
      ) : (
        <TradesTable trades={trades} caption="Trades for this token’s position share, newest first" />
      )}
    </section>
  );
}

function TokenBody({ address }: { address: string }) {
  const q = useToken(address);
  useTitle(q.data ? `$${q.data.token.symbol} — ${q.data.token.name}` : q.error?.code === 'not_found' ? 'Token not registered' : 'Token');

  if (!q.data) {
    if (q.error?.code === 'not_found') {
      return (
        <div className="container page">
          <header className="page-head">
            <div>
              <p className="page-head__eyebrow">Token</p>
              <h1>Token not registered</h1>
            </div>
          </header>
          <Empty
            title={`${BRAND.name} has no ledger for this address`}
            icon="search"
            action={
              <Link to="/launch" className="btn btn--primary btn--sm">
                Register a token
              </Link>
            }
          >
            <p>
              <code className="num break">{address}</code>
            </p>
            <p>If you just launched it, finish the last step of the launch wizard. Otherwise double-check the address.</p>
          </Empty>
        </div>
      );
    }
    return (
      <div className="container page">
        {q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="This token" /> : <Loading label="token" height={140} count={3} />}
      </div>
    );
  }

  const d = q.data;
  const t = d.token;
  return (
    <div className="container page token">
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
      <Identity d={d} />
      <StatusNote d={d} />

      <div className="token__top">
        <section className="card" aria-labelledby="decision-title">
          <h2 id="decision-title" className="panel-label">
            The engine’s call right now
          </h2>
          <Decision decision={t.decision} large />
        </section>
        <section className="card" aria-label="Step meter">
          <StepMeter burnedPct={t.book.supplyBurnedPct} tokensBurned={t.book.tokensBurned} buybackEth={t.book.buybackEth} symbol={t.symbol} />
        </section>
      </div>

      <section className="block" aria-labelledby="book-title">
        <div className="block-head">
          <h2 id="book-title">Book</h2>
          <p className="muted small">Everything the engine holds and has done for ${t.symbol}, from its ledger.</p>
        </div>
        <Book d={d} />
      </section>

      <PositionShare d={d} />
      <Charts address={t.address} symbol={t.symbol} market={t.market} />
      <Trades trades={d.trades} />

      <section className="block" aria-labelledby="timeline-title">
        <div className="block-head">
          <h2 id="timeline-title">Timeline</h2>
        </div>
        {d.activity.length === 0 ? (
          <Empty title="Nothing yet" icon="bolt">
            Registration, claims, trades and burns for ${t.symbol} will be listed here.
          </Empty>
        ) : (
          <ActivityList events={d.activity} showToken={false} />
        )}
      </section>

      <CreatorSettings token={t} />
    </div>
  );
}

export default function Token() {
  const { address = '' } = useParams();
  if (!isAddress(address)) return <NotFound />;
  // Keyed so local state (chart interval, settings form) resets when navigating between tokens.
  return <TokenBody key={address.toLowerCase()} address={address} />;
}
