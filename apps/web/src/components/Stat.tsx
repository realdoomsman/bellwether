import type { ReactNode } from 'react';
import { tone, usd } from '../lib/format';
import { Led } from './Led';

export function Stat({
  label,
  value,
  sub,
  led = false,
  valueClass = '',
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Dot-matrix display numerals; reserve for headline stats. */
  led?: boolean;
  valueClass?: string;
  children?: ReactNode;
}) {
  return (
    <div className="stat">
      <dt className="stat__label">{label}</dt>
      <dd className={`stat__value ${led ? 'stat__value--led' : 'num'} ${valueClass}`}>{led && typeof value === 'string' ? <Led text={value} /> : value}</dd>
      {sub !== undefined && <dd className="stat__sub">{sub}</dd>}
      {children}
    </div>
  );
}

/** Signed USD PnL. Direction is carried by the arrow and text, not color alone. */
export function Pnl({ value, compact = false }: { value: number | null | undefined; compact?: boolean }) {
  if (value === null || value === undefined) return <span className="num muted">—</span>;
  const t = tone(value);
  return (
    <span className={`num pnl ${t}`}>
      {t && (
        <span aria-hidden="true" className="pnl__arrow">
          {t === 'up' ? '▲' : '▼'}
        </span>
      )}
      {usd(value, { signed: true, compact })}
      {t && <span className="sr-only">{t === 'up' ? ' profit' : ' loss'}</span>}
    </span>
  );
}
