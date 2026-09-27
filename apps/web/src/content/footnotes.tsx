import { BRAND } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Site-wide numbered footnotes (risk and legal). The footer lists them; copy anywhere links to one
 * with <Fn id="…" />, so every claim points at the disclosure that qualifies it.
 */
export const FOOTNOTES = [
  {
    id: 'paper',
    body: (
      <>
        While the engine runs in paper mode, prices are live from Hyperliquid but {BRAND.name}’s claims, trades and burns are simulated and no funds move. Amounts it
        simulates are marked PAPER.
      </>
    ),
  },
  {
    id: 'figures',
    body: (
      <>
        Figures come from the engine’s ledger and are reconciled every minute against on-chain and venue balances. Each shows when it was last updated; check them yourself on{' '}
        <Link to="/proof">Proof</Link>.
      </>
    ),
  },
  {
    id: 'leverage',
    body: <>Positions use leverage. Stops can slip in fast markets, positions can be liquidated, and a token’s trading book can go to zero.</>,
  },
  {
    id: 'custody',
    body: <>The engine is off-chain software that holds the protocol wallet’s key. There is no smart-contract vault, and the software is unaudited.</>,
  },
  {
    id: 'advice',
    body: (
      <>
        Memecoins are extremely volatile and buybacks guarantee no price. Nothing here is financial advice. <Link to="/docs#risks">Read the risks</Link>.
      </>
    ),
  },
] as const satisfies readonly { id: string; body: ReactNode }[];

export type FootnoteId = (typeof FOOTNOTES)[number]['id'];

/** Superscript link to a footer footnote: <Fn id="leverage" />. */
export function Fn({ id }: { id: FootnoteId }) {
  const n = FOOTNOTES.findIndex((f) => f.id === id) + 1;
  return (
    <sup className="fn">
      <a href={`#fn-${id}`} aria-label={`Footnote ${n}`}>
        {n}
      </a>
    </sup>
  );
}
