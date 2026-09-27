import type { ActivityEvent, ActivityKind } from '@bellwether/shared';
import { compact, eth, usd } from '../lib/format';

/** How each engine event reads in prints, receipts and feeds. */
export type PrintTone = 'claim' | 'burn' | 'up' | 'down' | 'quiet';

export const KIND_LABEL: Record<ActivityKind, string> = {
  registered: 'Registered',
  activated: 'Activated',
  claim: 'Fees claimed',
  bridge: 'Bridged',
  open: 'Opened',
  reduce: 'Took profit',
  close: 'Closed',
  stop: 'Stopped out',
  liquidated: 'Liquidated',
  buyback: 'Buyback & burn',
  risk: 'Risk control',
  settings: 'Settings changed',
  'kill-switch': 'Kill switch',
};

export const KIND_TONE: Record<ActivityKind, PrintTone> = {
  registered: 'quiet',
  activated: 'quiet',
  claim: 'claim',
  bridge: 'quiet',
  open: 'up',
  reduce: 'up',
  close: 'down',
  stop: 'down',
  liquidated: 'down',
  buyback: 'burn',
  risk: 'down',
  settings: 'quiet',
  'kill-switch': 'down',
};

/** Glyph per kind; buybacks use the bell glyph (rendered by the component, so null here). */
export const KIND_GLYPH: Record<ActivityKind, string | null> = {
  registered: '·',
  activated: '·',
  claim: '○',
  bridge: '⇄',
  open: '▲',
  reduce: '▲',
  close: '▼',
  stop: '▼',
  liquidated: '✕',
  buyback: null,
  risk: '—',
  settings: '·',
  'kill-switch': '—',
};

const VERB: Record<ActivityKind, string> = {
  registered: 'registered',
  activated: 'went live',
  claim: 'claimed',
  bridge: 'bridged',
  open: 'opened',
  reduce: 'took profit',
  close: 'closed',
  stop: 'stopped out',
  liquidated: 'liquidated',
  buyback: 'burned',
  risk: 'risk control',
  settings: 'settings changed',
  'kill-switch': 'kill switch',
};

/** Registration noise stays out of the tape. */
export const TAPE_KINDS: Partial<Record<ActivityKind, true>> = {
  claim: true,
  bridge: true,
  open: true,
  reduce: true,
  close: true,
  stop: true,
  liquidated: true,
  buyback: true,
  risk: true,
  'kill-switch': true,
};

/** Simulated events carry `paper:` tx refs; they're labelled PAPER and never linked. */
export function isPaperEvent(e: ActivityEvent): boolean {
  return e.txs.some((t) => t.hash.startsWith('paper:') || t.url === null);
}

/** The subject of a print: the token when there is one, else the market (pooled positions). */
export function subject(e: ActivityEvent): string | null {
  if (e.tokenSymbol) return `$${e.tokenSymbol}`;
  return e.market ?? null;
}

/** Short amount for a print: tokens burned for burns, ETH for claims, USD for trades. */
export function printAmount(e: ActivityEvent): string | null {
  if (e.kind === 'buyback' && e.tokensBurned !== undefined) return compact(e.tokensBurned);
  if (e.amountEth !== undefined) return eth(e.amountEth);
  if (e.amountUsd !== undefined) return usd(e.amountUsd);
  return null;
}

export function printVerb(e: ActivityEvent): string {
  const market = e.market && e.tokenSymbol && (e.kind === 'open' || e.kind === 'close' || e.kind === 'reduce' || e.kind === 'stop') ? ` ${e.market}` : '';
  return `${VERB[e.kind]}${market}`;
}
