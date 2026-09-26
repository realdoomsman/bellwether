import type { ActivityEvent, ActivityKind } from '@floor/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { compact, dateTime, eth, relTime, usd } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useActivity } from '../lib/queries';
import { Empty, ErrorNotice, Loading, StaleNote } from './DataState';
import { Icon, type IconName } from './Icon';
import { TxLinks } from './Links';

const KIND: Record<ActivityKind, { label: string; icon: IconName; accent?: boolean }> = {
  registered: { label: 'Registered', icon: 'steps' },
  activated: { label: 'Activated', icon: 'bolt', accent: true },
  claim: { label: 'Fees claimed', icon: 'wallet' },
  bridge: { label: 'Bridged', icon: 'arrowRight' },
  open: { label: 'Opened', icon: 'arrowRight' },
  reduce: { label: 'Took profit', icon: 'steps' },
  close: { label: 'Closed', icon: 'check' },
  stop: { label: 'Stopped out', icon: 'shield' },
  liquidated: { label: 'Liquidated', icon: 'warn' },
  buyback: { label: 'Buyback & burn', icon: 'flame', accent: true },
  risk: { label: 'Risk control', icon: 'shield' },
  settings: { label: 'Settings changed', icon: 'steps' },
  'kill-switch': { label: 'Kill switch', icon: 'shield' },
};

export function ActivityList({ events, showToken = true }: { events: ActivityEvent[]; showToken?: boolean }) {
  const now = useNow(15_000);
  const seen = useRef<Set<string> | null>(null);
  // Everything present on first render is "old"; later arrivals get a highlight.
  if (seen.current === null) seen.current = new Set(events.map((e) => e.id));
  const fresh = events.filter((e) => !seen.current?.has(e.id)).map((e) => e.id);
  useEffect(() => {
    for (const id of fresh) seen.current?.add(id);
  });

  return (
    <ol className="feed">
      {events.map((e) => {
        const k = KIND[e.kind];
        return (
          <li key={e.id} className={`feed__item ${k.accent ? 'feed__item--accent' : ''} ${fresh.includes(e.id) ? 'is-new' : ''}`}>
            <span className="feed__icon" aria-hidden="true">
              <Icon name={k.icon} size={16} />
            </span>
            <div className="feed__body">
              <p className="feed__top">
                <span className="feed__kind">{k.label}</span>
                {showToken && e.token && e.tokenSymbol && (
                  <Link to={`/t/${e.token}`} className="feed__token">
                    ${e.tokenSymbol}
                  </Link>
                )}
                {e.market && <span className="feed__market num">{e.market}</span>}
                <time className="feed__time" dateTime={new Date(e.at).toISOString()} title={dateTime(e.at)}>
                  {relTime(e.at, now)}
                </time>
              </p>
              <p className="feed__title">{e.title}</p>
              {(e.amountEth !== undefined || e.amountUsd !== undefined || e.tokensBurned !== undefined) && (
                <p className="feed__amounts num">
                  {e.amountEth !== undefined && <span>{eth(e.amountEth)}</span>}
                  {e.amountUsd !== undefined && <span>{usd(e.amountUsd)}</span>}
                  {e.tokensBurned !== undefined && (
                    <span className="amber">
                      <Icon name="flame" size={12} /> {compact(e.tokensBurned)} burned
                    </span>
                  )}
                </p>
              )}
              <TxLinks txs={e.txs} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** App-wide live feed: SSE-prepended, with manual paging into older history. */
export function LiveActivity() {
  const q = useActivity();
  const [older, setOlder] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  if (!q.data) {
    return q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Activity" /> : <Loading label="activity" height={64} count={4} />;
  }

  const next = cursor === undefined ? q.data.nextBefore : cursor;
  const events = [...q.data.events, ...older.filter((o) => !q.data?.events.some((e) => e.id === o.id))];

  const loadMore = async () => {
    if (next === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.activity({ before: next, limit: 50 });
      setOlder((prev) => [...prev, ...page.events]);
      setCursor(page.nextBefore);
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  if (events.length === 0) {
    return (
      <Empty title="No activity yet" icon="bolt">
        Claims, trades and burns show up here the moment the engine does them.
      </Empty>
    );
  }

  return (
    <div className="feed-wrap">
      <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
      <ActivityList events={events} />
      {next !== null && (
        <button type="button" className="btn btn--ghost btn--sm btn--block" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load older activity'}
        </button>
      )}
      {moreError && <p className="field__hint">{moreError}</p>}
    </div>
  );
}
