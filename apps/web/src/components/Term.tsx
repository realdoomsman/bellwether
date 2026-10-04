import { BRAND, BURN_ADDRESS } from '@bellwether/shared';
import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { shortAddr } from '../lib/format';
import { useAnchoredPosition } from './Popover';

/** Plain-language definitions for the jargon the product can't avoid. */
export const GLOSSARY = {
  mark: 'Mark price: the venue’s fair price for the perp, used for unrealized PnL and liquidations. It can differ from the last trade.',
  liquidation: 'Liquidation price: if the mark reaches it, the venue closes the position and the collateral behind it is lost.',
  leverage: 'Leverage: position size divided by collateral. At 10× a 10% move against the position wipes out its collateral.',
  funding: 'Funding: periodic payments between longs and shorts that keep the perp near the stock price. Paid or received every hour.',
  buyback: `Buyback & burn: the engine buys the token on its DEX with ETH and sends it to the burn address, so supply only goes down.`,
  burnAddress: `Burn address: ${shortAddr(BURN_ADDRESS)}. Nobody holds a key to it, so tokens sent there are gone for good.`,
  paper: `Paper mode: prices are live from Hyperliquid, but ${BRAND.name}’s trades, claims and burns are simulated. No funds move.`,
  session: 'Session: the US stock market’s trading window in New York time (pre-market, regular hours, after hours, overnight, weekend, holiday). The perps trade 24/7; strategies only open new positions in their chosen sessions, and exits run in all of them.',
  signal: 'Signal: the engine’s entry score from −100 to 100 for a market. Long entries need the score above the strategy’s threshold.',
  perp: 'Perp: a perpetual future. It tracks the stock’s price with no expiry, settled in USDC on Hyperliquid, and trades 24/7: outside US hours its price comes from the venue’s own order book.',
} as const;

export type TermId = keyof typeof GLOSSARY;

/**
 * Dotted-underline term with a definition on hover or focus (Hyperliquid-style glossary).
 * Pass `id` for a glossary entry or `tip` for a one-off definition.
 */
export function Term({ id, tip, children }: { id?: TermId; tip?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const pos = useAnchoredPosition(anchor, panel, open, 'top');
  const text = tip ?? (id ? GLOSSARY[id] : null);
  if (!text) return <>{children}</>;
  return (
    <>
      <span
        ref={anchor}
        className="term"
        tabIndex={0}
        aria-describedby={open ? tipId : undefined}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <span
            ref={panel}
            id={tipId}
            role="tooltip"
            className="tip"
            data-side={pos?.side ?? 'top'}
            data-ready={pos ? '' : undefined}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0 }}
          >
            {text}
          </span>,
          document.body,
        )}
    </>
  );
}
