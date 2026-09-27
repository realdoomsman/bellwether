import { CHAINS, type ActivityEvent } from '@bellwether/shared';
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { compact, etDateTime, eth, relTime, shortAddr, usd } from '../lib/format';
import { useNow } from '../lib/hooks';
import { isPaperEvent, KIND_LABEL } from './activityMeta';
import { BellGlyph } from './Logo';
import { Popover } from './Popover';

/** Receipt rows for one engine event: what, which token, how much, where, when, and the transactions. */
export function ReceiptBody({ event: e, paper }: { event: ActivityEvent; paper: boolean }) {
  const now = useNow(15_000);
  const simulated = paper || isPaperEvent(e);
  const amounts = [
    e.tokensBurned !== undefined && `${compact(e.tokensBurned)} ${e.tokenSymbol ? `$${e.tokenSymbol}` : 'tokens'} burned`,
    e.amountEth !== undefined && eth(e.amountEth),
    e.amountUsd !== undefined && usd(e.amountUsd),
  ].filter(Boolean) as string[];
  const chains = [...new Set(e.txs.map((t) => CHAINS[t.chain].name))];
  return (
    <>
      <p className="receipt__kind">
        {e.kind === 'buyback' && <BellGlyph className="receipt__bell" />}
        {KIND_LABEL[e.kind]}
        {simulated && <span className="paper-tag">PAPER</span>}
      </p>
      <p className="receipt__title">{e.title}</p>
      <dl className="receipt__rows">
        {e.token && e.tokenSymbol && (
          <div>
            <dt>Token</dt>
            <dd>
              <Link to={`/t/${e.token}`}>${e.tokenSymbol}</Link>
            </dd>
          </div>
        )}
        {amounts.length > 0 && (
          <div>
            <dt>Amount</dt>
            <dd className="num">{amounts.join(' · ')}</dd>
          </div>
        )}
        {e.market && (
          <div>
            <dt>Market</dt>
            <dd className="num">{e.market}-PERP</dd>
          </div>
        )}
        {chains.length > 0 && (
          <div>
            <dt>{simulated ? 'Venue' : 'Chain'}</dt>
            <dd>{simulated ? `Simulated · ${chains.join(', ')} prices` : chains.join(', ')}</dd>
          </div>
        )}
        <div>
          <dt>Time</dt>
          <dd>
            <time dateTime={new Date(e.at).toISOString()}>{etDateTime(e.at)}</time> <span className="muted">· {relTime(Math.min(e.at, now), now)}</span>
          </dd>
        </div>
        {e.txs.length > 0 && (
          <div>
            <dt>{e.txs.length > 1 ? 'Transactions' : 'Transaction'}</dt>
            <dd className="receipt__txs">
              {e.txs.map((t) =>
                t.url && !t.hash.startsWith('paper:') ? (
                  <a key={t.hash} href={t.url} target="_blank" rel="noopener noreferrer" className="num">
                    {CHAINS[t.chain].name} {shortAddr(t.hash, 6, 4)} ↗<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <span key={t.hash} className="num muted" title="Simulated reference: no on-chain transaction">
                    {t.hash.replace(/^paper:/, 'paper ref ')}
                  </span>
                ),
              )}
            </dd>
          </div>
        )}
      </dl>
      <Link to="/proof" className="receipt__verify">
        Verify on Proof →
      </Link>
    </>
  );
}

/** Inline receipt: paper-2 slip with a zig-zag tear at the bottom. */
export function Receipt({ event, paper = false, className }: { event: ActivityEvent; paper?: boolean; className?: string }) {
  return (
    <article className={`receipt${className ? ` ${className}` : ''}`} aria-label={`Receipt: ${KIND_LABEL[event.kind]}`}>
      <ReceiptBody event={event} paper={paper} />
    </article>
  );
}

/** A trigger that opens the event's receipt in a popover. `children` is the trigger content. */
export function ReceiptTrigger({
  event,
  paper = false,
  className,
  children,
  label,
  tabIndex,
}: {
  event: ActivityEvent;
  paper?: boolean;
  className?: string;
  children: ReactNode;
  label?: string;
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        tabIndex={tabIndex}
        onClick={() => setOpen((v) => !v)}
      >
        {children}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={`Receipt: ${KIND_LABEL[event.kind]}`} className="popover--receipt">
        <div className="receipt">
          <ReceiptBody event={event} paper={paper} />
        </div>
      </Popover>
    </>
  );
}
