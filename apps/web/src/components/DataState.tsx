import type { ReactNode } from 'react';
import type { ApiRequestError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { etTime } from '../lib/format';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';

/** Placeholder blocks at final dimensions: static, no shimmer (the header progress line shows real waits). */
export function Skeleton({ height = 16, count = 1 }: { height?: number; count?: number }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

/** Loading placeholder that also tells screen readers something is happening. */
export function Loading({ label, height = 120, count = 1 }: { label: string; height?: number; count?: number }) {
  return (
    <div className="loading" role="status">
      <span className="sr-only">Loading {label}…</span>
      <Skeleton height={height} count={count} />
    </div>
  );
}

/** Engine unreachable vs. a real error: human copy, the code in mono for support, one retry. */
export function ErrorNotice({
  error,
  onRetry,
  what,
  compact = false,
  offlineHint = 'Nothing has loaded yet, so there are no last known values to show. Retrying automatically.',
}: {
  error: ApiRequestError;
  onRetry?: () => void;
  what: string;
  compact?: boolean;
  /** What the user can still do while the engine is unreachable. */
  offlineHint?: string;
}) {
  const offline = error.offline;
  return (
    <div className={`notice${offline ? ' notice--offline' : ' notice--error'}${compact ? ' notice--compact' : ''}`} role="status">
      <div className="notice__body">
        <p className="notice__title">
          <StatusDot tone="offline">{offline ? `${what}: engine unreachable` : `Couldn’t load ${what.toLowerCase()}`}</StatusDot>
        </p>
        <p className="notice__text">{offline ? offlineHint : errorMessage(error)}</p>
        {!offline && (
          <p className="notice__code">
            {error.code}
            {error.status ? ` · HTTP ${error.status}` : ''}
          </p>
        )}
      </div>
      {onRetry && (
        <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>
          <Icon name="refresh" /> Retry
        </button>
      )}
    </div>
  );
}

/** Empty state: one sentence about what happens next, plus at most one action. No illustrations. */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <div className="empty__text">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

/** Whole-page offline state: one calm statement instead of a stack of per-section errors. */
export function EngineDark({ children }: { children?: ReactNode }) {
  return (
    <section className="dark-panel" role="status" aria-labelledby="dark-title">
      <StatusDot tone="offline">Engine unreachable</StatusDot>
      <h2 id="dark-title" className="dark-panel__title">
        The engine isn’t answering.
      </h2>
      <p className="dark-panel__text">Anything shown here would be a guess, so nothing is. This page reconnects on its own and fills in the moment the engine is back.</p>
      {children && <div className="row dark-panel__actions">{children}</div>}
    </section>
  );
}

/** Shown next to data when the latest refresh failed and we're displaying the last good copy. */
export function StaleNote({ stale, updatedAt }: { stale: boolean; updatedAt: number | null }) {
  if (!stale) return null;
  return (
    <p className="stale" role="status">
      <StatusDot tone="pending">Reconnecting</StatusDot>
      <span>Last known values{updatedAt ? ` as of ${etTime(updatedAt)}` : ''} (stale)</span>
    </p>
  );
}
