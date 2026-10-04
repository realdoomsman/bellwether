import type { Format } from '@number-flow/react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { etTime } from '../lib/format';
import type { ApiState } from '../lib/useApi';
import { Icon } from './Icon';
import { RollingNumber } from './RollingNumber';

export type FigureKind = 'usd' | 'eth' | 'int' | 'compact' | 'pct';
export type FigureStatus = 'loading' | 'live' | 'stale' | 'offline';

/** Number formats for rolling figures; they match lib/format.ts (ETH: 3 decimals from 1, else 4 significant). */
export function figureFormat(kind: FigureKind, value: number): Format {
  switch (kind) {
    case 'usd':
      return { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 };
    case 'eth':
      return Math.abs(value) >= 1 || value === 0 ? { minimumFractionDigits: value === 0 ? 0 : 3, maximumFractionDigits: 3 } : { maximumSignificantDigits: 4 };
    case 'int':
      return { maximumFractionDigits: 0 };
    case 'compact':
      return { notation: 'compact', maximumFractionDigits: 2 };
    case 'pct':
      return { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 };
  }
}

/** Figure state from a query: offline only when there's an error, stale when we're showing last-known data. */
export function figureStatus(q: Pick<ApiState<unknown>, 'data' | 'error' | 'stale'>): FigureStatus {
  if (q.data === undefined) return q.error ? 'offline' : 'loading';
  if (q.stale) return q.error?.offline ? 'offline' : 'stale';
  return 'live';
}

export type FigureSource = { label: string; to: string } | { label: string; href: string };

/**
 * Ledger figure: serif numerals that roll to new values, a label, and a footnote with "as of" and source.
 * Unknown values render "—" at final size, never 0. Offline dims the figure and offers a retry.
 */
export function Figure({
  label,
  value,
  kind = 'int',
  unit,
  sub,
  asOf,
  source,
  status = 'live',
  paper = false,
  onRetry,
  size = 'md',
}: {
  label: ReactNode;
  value: number | null | undefined;
  kind?: FigureKind;
  unit?: string;
  sub?: ReactNode;
  asOf?: number | null;
  source?: FigureSource;
  status?: FigureStatus;
  paper?: boolean;
  onRetry?: () => void;
  size?: 'sm' | 'md' | 'lg';
}) {
  const known = value !== null && value !== undefined && Number.isFinite(value);
  const format = known ? figureFormat(kind, value) : undefined;
  // The printed length lets CSS shrink long numerals to the column (.figure__value).
  const chars = known ? new Intl.NumberFormat('en-US', format).format(value).length : 1;
  return (
    <div className={`figure figure--${size}`} data-status={status}>
      <dt className="figure__label">{label}</dt>
      <dd className="figure__value" style={{ '--figure-chars': chars } as CSSProperties}>
        {known ? <RollingNumber value={value} format={format} className="figure__num" /> : <span className="figure__num figure__num--empty">—</span>}
        {unit && <span className="figure__unit">{unit}</span>}
        {paper && known && <span className="paper-tag">PAPER</span>}
      </dd>
      {sub && <dd className="figure__sub">{sub}</dd>}
      <dd className="figure__note">
        {status === 'offline' ? (
          <>
            <span>Engine unreachable{asOf ? ` · last update ${etTime(asOf)}` : ''}</span>
            {onRetry && (
              <button type="button" className="link-btn" onClick={onRetry}>
                <Icon name="refresh" size={12} /> Retry
              </button>
            )}
          </>
        ) : status === 'loading' ? (
          <span>Connecting to the engine…</span>
        ) : (
          <>
            <span className={status === 'stale' ? 'figure__stale' : undefined}>
              {asOf ? `as of ${etTime(asOf, { seconds: true })}` : 'as of —'}
              {status === 'stale' && ' (stale)'}
            </span>
            {source && (
              <>
                <span aria-hidden="true"> · </span>
                {'to' in source ? (
                  <Link to={source.to}>{source.label}</Link>
                ) : (
                  <a href={source.href} target="_blank" rel="noopener noreferrer">
                    {source.label} ↗<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

/** A ruled row of figures (a <dl>); columns collapse on small screens. */
export function FigureRow({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <dl className={`figures${className ? ` ${className}` : ''}`} aria-label={label}>
      {children}
    </dl>
  );
}
