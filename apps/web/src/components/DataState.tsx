import type { CSSProperties, ReactNode } from 'react';
import type { ApiRequestError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { relTime } from '../lib/format';
import { Icon } from './Icon';

export function Skeleton({ height = 16, count = 1, radius }: { height?: number; count?: number; radius?: number }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, borderRadius: radius } as CSSProperties} />
      ))}
    </div>
  );
}

/** Loading placeholder that also tells screen readers something is happening. */
export function Loading({ label, height = 120, count = 1 }: { label: string; height?: number; count?: number }) {
  return (
    <div className="loading" role="status">
      <span className="sr-only">Loading {label}…</span>
      <Skeleton height={height} count={count} radius={12} />
    </div>
  );
}

/** Engine unreachable vs. a real error: different copy, same retry affordance. */
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
    <div className={`notice ${offline ? 'notice--offline' : 'notice--error'} ${compact ? 'notice--compact' : ''}`} role="status">
      <div className="notice__icon" aria-hidden="true">
        {offline ? <span className="notice__dots" /> : <Icon name="warn" size={20} />}
      </div>
      <div className="notice__body">
        <p className="notice__title">{offline ? `${what} unavailable — engine offline` : `Couldn't load ${what}`}</p>
        <p className="notice__text">{offline ? offlineHint : errorMessage(error)}</p>
      </div>
      {onRetry && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
          <Icon name="refresh" /> Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children, action, icon = 'steps' }: { title: string; children?: ReactNode; action?: ReactNode; icon?: 'steps' | 'flame' | 'bolt' | 'search' }) {
  return (
    <div className="empty">
      <Icon name={icon} size={22} className="empty__icon" />
      <p className="empty__title">{title}</p>
      {children && <div className="empty__text">{children}</div>}
      {action}
    </div>
  );
}

/** Whole-page offline state: one calm panel instead of a stack of per-section errors. */
export function EngineDark({ children }: { children?: ReactNode }) {
  return (
    <section className="dark-panel" role="status" aria-labelledby="dark-title">
      <p className="dark-panel__led led" aria-hidden="true">
        OFFLINE
      </p>
      <h2 id="dark-title" className="dark-panel__title">
        The engine isn’t answering.
      </h2>
      <p className="dark-panel__text">
        Anything shown here would be a guess, so nothing is. This page reconnects on its own and fills in the moment the engine is back.
      </p>
      {children && <div className="row dark-panel__actions">{children}</div>}
    </section>
  );
}

/** Shown next to data when the latest refresh failed and we're displaying the last good copy. */
export function StaleNote({ stale, updatedAt }: { stale: boolean; updatedAt: number | null }) {
  if (!stale) return null;
  return (
    <span className="stale" role="status">
      <span className="stale__dot" aria-hidden="true" />
      Last known values · updated {relTime(updatedAt)} · reconnecting
    </span>
  );
}
