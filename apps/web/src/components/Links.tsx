import { addressUrl, CHAINS, type ChainKey, type TxRef } from '@bellwether/shared';
import { Children, type ReactNode } from 'react';
import { shortAddr } from '../lib/format';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';

/**
 * The arrow is an atomic inline, so the browser may wrap it onto a line of its own after the link text.
 * When the link ends in text, the last word and the arrow share a no-wrap span so they always stay together.
 */
function withArrow(children: ReactNode): ReactNode[] {
  const arrow = <Icon key="arrow" name="external" size={12} className="ext__icon" />;
  const list = Children.toArray(children);
  const last = list[list.length - 1];
  if (typeof last !== 'string') return [...list, arrow];
  const start = last.search(/\S+\s*$/);
  if (start < 0) return [...list, arrow];
  return [
    ...list.slice(0, -1),
    last.slice(0, start),
    <span key="tail" className="ext__tail">
      {last.slice(start)}
      {arrow}
    </span>,
  ];
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className ? `ext ${className}` : 'ext'}>
      {withArrow(children)}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

const CHAIN_SHORT: Record<ChainKey, string> = { rhc: 'RHC', arbitrum: 'ARB', hyperliquid: 'HL' };

/** Paper refs (`paper:<id>`, url null) are simulated and never rendered as links. */
export function TxLinks({ txs }: { txs: TxRef[] }) {
  if (txs.length === 0) return null;
  return (
    <span className="txs">
      {txs.map((tx) =>
        tx.url && !tx.hash.startsWith('paper:') ? (
          <ExtLink key={tx.hash} href={tx.url} className="tx">
            {CHAIN_SHORT[tx.chain]} {shortAddr(tx.hash, 6, 4)}
          </ExtLink>
        ) : (
          <span key={tx.hash} className="tx tx--paper" title={`Simulated (${tx.hash}) — no on-chain transaction`}>
            paper · {CHAIN_SHORT[tx.chain]}
          </span>
        ),
      )}
    </span>
  );
}

/** Address with explorer link and copy. */
export function AddressChip({ address, chain = 'rhc', what = 'address', full = false }: { address: string; chain?: ChainKey; what?: string; full?: boolean }) {
  return (
    <span className="addr">
      <ExtLink href={addressUrl(chain, address)} className="addr__link num">
        {full ? address : shortAddr(address)}
      </ExtLink>
      <CopyButton text={address} what={what} iconOnly className="icon-btn icon-btn--sm" />
      <span className="sr-only">on {CHAINS[chain].name}</span>
    </span>
  );
}
