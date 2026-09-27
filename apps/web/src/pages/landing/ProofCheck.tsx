import { addressUrl, BURN_ADDRESS, type ActivityEvent } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { CopyButton } from '../../components/CopyButton';
import { Muted, Section } from '../../components/Primitives';
import { Receipt } from '../../components/Receipt';
import { StatusDot } from '../../components/StatusDot';
import { etDateTime, int, relTime, shortAddr } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useActivity, usePaperMode, useProof, useStats } from '../../lib/queries';

const TRADE_KINDS: Partial<Record<ActivityEvent['kind'], true>> = { open: true, reduce: true, close: true, stop: true, liquidated: true };

/** The reconciliation verdict, stated as a sentence with when it was checked. */
function Verdict() {
  const q = useProof();
  const now = useNow();
  const p = q.data;
  if (!p) {
    return (
      <p className="ld-proof__verdict">
        <StatusDot tone={q.error ? 'offline' : 'idle'}>{q.error ? 'Engine unreachable.' : 'Checking the books…'}</StatusDot>
        {q.error && <span>The verdict loads when it’s back.</span>}
      </p>
    );
  }
  const { checkedAt, items } = p.reconciliation;
  if (checkedAt === null) {
    return (
      <p className="ld-proof__verdict">
        <StatusDot tone="idle">Not checked yet.</StatusDot>
        <span>The reconciler hasn’t finished its first run.</span>
      </p>
    );
  }
  const drifting = items.filter((i) => !i.ok).length;
  return (
    <p className="ld-proof__verdict">
      {drifting === 0 ? (
        <StatusDot tone="live">
          <strong>Books balance.</strong>
        </StatusDot>
      ) : (
        <StatusDot tone="offline">
          <strong>
            Drift on {int(drifting)} of {int(items.length)} balances.
          </strong>
        </StatusDot>
      )}
      <span>
        {drifting === 0 ? `${int(items.length)} of ${int(items.length)} balances match the ledger` : 'Shown on Proof, not hidden'} · checked{' '}
        <time dateTime={new Date(checkedAt).toISOString()} title={etDateTime(checkedAt)}>
          {relTime(Math.min(checkedAt, now), now)}
        </time>
        {q.stale && ' (stale)'}
      </span>
    </p>
  );
}

/** One slot of the receipt row: the real receipt, or a sentence about what fills it. */
function Slot({ title, event, empty }: { title: string; event: ActivityEvent | undefined; empty: ReactNode }) {
  const paper = usePaperMode();
  return (
    <div className="ld-proof__slot">
      <p className="label">{title}</p>
      {event ? <Receipt event={event} paper={paper} /> : <p className="ld-proof__empty small">{empty}</p>}
    </div>
  );
}

/** §6 Don't trust us. Check: the latest real receipts and the reconciliation verdict. */
export function ProofCheck({ n }: { n: number }) {
  const activity = useActivity();
  const stats = useStats().data;
  const events = activity.data?.events ?? [];
  const loading = activity.data === undefined;
  const pending = loading ? (activity.error ? 'Engine unreachable.' : 'Connecting to the engine…') : null;
  const open = stats?.openPositions ?? 0;
  const closed = stats?.trades ?? 0;

  return (
    <Section
      id="proof"
      n={n}
      label="Proof"
      className="ld-proof"
      title={
        <>
          Don’t trust us. <Muted>Check.</Muted>
        </>
      }
      lede="Every claim, burn and trade has a receipt with its transactions. The internal ledger is reconciled against real wallet and venue balances, and drift is shown, not hidden."
      aside={
        <Link to="/proof" className="btn btn--secondary">
          Open Proof
        </Link>
      }
    >
      <Verdict />
      <div className="ld-proof__row">
        <Slot title="Latest claim" event={events.find((e) => e.kind === 'claim')} empty={pending ?? 'No fees claimed yet. The first claim lands once a registered token earns fees.'} />
        <Slot title="Latest buyback and burn" event={events.find((e) => e.kind === 'buyback')} empty={pending ?? 'No burn yet. The first follows the first claim.'} />
        <Slot
          title="Latest trade"
          event={events.find((e) => TRADE_KINDS[e.kind])}
          empty={
            pending ?? (
              <>
                {closed > 0 ? `${int(closed)} closed ${closed === 1 ? 'trade' : 'trades'}, none in the latest activity.` : 'No closed trades yet.'}{' '}
                {open > 0 ? `${int(open)} ${open === 1 ? 'position is' : 'positions are'} open.` : 'Entries wait for each strategy’s session and signal.'} <Link to="/app">See Live</Link>
              </>
            )
          }
        />
      </div>
      <p className="ld-proof__burn small">
        <span className="label">Burn address</span>
        <code className="num">{shortAddr(BURN_ADDRESS, 8, 6)}</code>
        <CopyButton text={BURN_ADDRESS} what="burn address" iconOnly className="icon-btn icon-btn--sm" />
        <a href={addressUrl('rhc', BURN_ADDRESS)} target="_blank" rel="noopener noreferrer">
          Explorer ↗<span className="sr-only"> (opens in a new tab)</span>
        </a>
        <span className="muted">Nobody holds a key to it.</span>
      </p>
    </Section>
  );
}
