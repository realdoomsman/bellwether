import { addressUrl } from '@bellwether/shared';
import { Fragment, type ReactNode } from 'react';
import { ExtLink } from '../../components/Links';
import { shortAddr } from '../../lib/format';
import { CheckMark, type CheckState } from './CheckMark';

export interface CheckRow {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  link?: { href: string; label: string } | null;
}

/** Engine detail text with every address shortened and linked to the explorer (full address on hover). */
function Detail({ text }: { text: string }) {
  const parts = text.split(/(0x[0-9a-fA-F]{40})/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={addressUrl('rhc', p)} target="_blank" rel="noopener noreferrer" className="num lw-checks__addr" title={p}>
            {shortAddr(p)}
            <span className="sr-only"> (full address {p}, opens the explorer in a new tab)</span>
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * The on-chain checks as a ledger: each row is struck (✓, ✕ or —) as its answer is revealed, one by one,
 * in the order the engine ran them. Unresolved rows say what they will check.
 */
export function Checklist({ rows, status }: { rows: CheckRow[]; status: ReactNode }) {
  return (
    <div className="lw-checks">
      <ol className="lw-checks__list" aria-label="On-chain checks">
        {rows.map((r) => (
          <li key={r.id} className="lw-checks__row" data-state={r.state}>
            <CheckMark state={r.state} />
            <div className="lw-checks__body">
              <p className="lw-checks__label">{r.label}</p>
              <p className="lw-checks__detail" key={`${r.state}:${r.detail}`}>
                <Detail text={r.detail} />
              </p>
            </div>
            {r.link && (
              <ExtLink href={r.link.href} className="lw-checks__link">
                {r.link.label}
              </ExtLink>
            )}
          </li>
        ))}
      </ol>
      <p className="lw-checks__status" role="status">
        {status}
      </p>
    </div>
  );
}
