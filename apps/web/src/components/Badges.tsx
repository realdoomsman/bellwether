import type { DecisionVerdict, MarketView, PositionView, TokenStatus } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { StatusDot, type StatusTone } from './StatusDot';

type Tone = 'brass' | 'neutral' | 'warn' | 'up' | 'down';

/** Quiet inline tag (a hairline box, sentence case). Use sparingly: most states are dot + text. */
export function Pill({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS: Record<TokenStatus, { label: string; tone: StatusTone } | null> = {
  active: null,
  pending: { label: 'Pending review', tone: 'pending' },
  paused: { label: 'Paused', tone: 'idle' },
  rejected: { label: 'Rejected', tone: 'offline' },
  retired: { label: 'Retired', tone: 'idle' },
};

/** Token status as dot + text. Active is the default and renders nothing. */
export function StatusPill({ status }: { status: TokenStatus }) {
  const s = STATUS[status];
  return s ? <StatusDot tone={s.tone}>{s.label}</StatusDot> : null;
}

export const VERDICT_LABEL: Record<DecisionVerdict, string> = {
  'pending-review': 'Pending review',
  'collecting-fees': 'Collecting fees',
  'below-minimum': 'Below minimum',
  'waiting-session': 'Waiting for session',
  'waiting-signal': 'Waiting for signal',
  'venue-paused': 'Venue paused',
  'kill-switch': 'Kill switch on',
  'daily-loss-limit': 'Daily loss limit hit',
  'in-position': 'In position',
  'burn-only': 'Burn only',
  paused: 'Paused',
};

const VERDICT_TONE: Record<DecisionVerdict, StatusTone> = {
  'pending-review': 'pending',
  'collecting-fees': 'idle',
  'below-minimum': 'idle',
  'waiting-session': 'idle',
  'waiting-signal': 'idle',
  'venue-paused': 'offline',
  'kill-switch': 'offline',
  'daily-loss-limit': 'offline',
  'in-position': 'live',
  'burn-only': 'idle',
  paused: 'idle',
};

/** The engine's verdict for a token, as dot + text. */
export function VerdictPill({ verdict }: { verdict: DecisionVerdict }) {
  return <StatusDot tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict]}</StatusDot>;
}

/** Market bias as text ("▲ Long 55"); direction is carried by the glyph, not color alone. */
export function BiasChip({ signal }: { signal: MarketView['signal'] }) {
  if (!signal) return <span className="muted">No signal</span>;
  const { bias, score } = signal;
  const label = bias === 'long' ? '▲ Long' : bias === 'short' ? '▼ Short' : 'Wait';
  return (
    <span className={bias === 'long' ? 'up' : bias === 'short' ? 'down' : 'muted'} title={`Entry signal score ${score} of 100`}>
      {label} <span className="num">{score}</span>
    </span>
  );
}

const STAGE: Record<PositionView['stage'], string> = {
  open: 'Open',
  breakeven: 'Stop at breakeven',
  tp1: 'TP1 taken',
  tp2: 'TP2 taken',
  trailing: 'Trailing',
};

export function StagePill({ stage }: { stage: PositionView['stage'] }) {
  return <StatusDot tone={stage === 'open' ? 'idle' : 'live'}>{STAGE[stage]}</StatusDot>;
}
