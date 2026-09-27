import type { ReactNode } from 'react';
import { pct, tone, usd } from '../lib/format';

/** Compact key/value figure for dense panels (the headline version is <Figure>). */
export function Stat({ label, value, sub, valueClass = '', children }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string; children?: ReactNode }) {
  return (
    <div className="stat">
      <dt className="stat__label">{label}</dt>
      <dd className={`stat__value ${valueClass}`}>{value}</dd>
      {sub !== undefined && <dd className="stat__sub">{sub}</dd>}
      {children}
    </div>
  );
}

/** Signed USD PnL. Direction is carried by the arrow and text, not color alone. */
export function Pnl({ value, compact = false }: { value: number | null | undefined; compact?: boolean }) {
  if (value === null || value === undefined) return <span className="num muted">—</span>;
  const text = usd(value, { signed: true, compact });
  const t = tone(text);
  return (
    <span className={`num pnl ${t}`}>
      {t && (
        <span aria-hidden="true" className="pnl__arrow">
          {t === 'up' ? '▲' : '▼'}
        </span>
      )}
      {text}
      {t && <span className="sr-only">{t === 'up' ? ' profit' : ' loss'}</span>}
    </span>
  );
}

/** Signed percent change (a fraction); arrow and colour follow the printed sign, so a rounded-away move is neutral. */
export function Change({ frac }: { frac: number }) {
  const text = pct(frac, { signed: true });
  const t = tone(text);
  return (
    <span className={`num ${t}`}>
      {t === 'up' ? '▲ ' : t === 'down' ? '▼ ' : ''}
      {text}
    </span>
  );
}
