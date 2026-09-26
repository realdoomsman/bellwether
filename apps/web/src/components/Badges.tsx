import type { DecisionVerdict, MarketView, PositionView, TokenStatus } from '@stepup/shared';
import type { ReactNode } from 'react';

type Tone = 'amber' | 'info' | 'neutral' | 'warn' | 'up' | 'down';

export function Pill({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS: Record<TokenStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'amber' },
  pending: { label: 'Pending review', tone: 'info' },
  paused: { label: 'Paused', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'warn' },
  retired: { label: 'Retired', tone: 'neutral' },
};

export function StatusPill({ status }: { status: TokenStatus }) {
  const s = STATUS[status];
  return (
    <Pill tone={s.tone}>
      <span className="pill__dot" aria-hidden="true" />
      {s.label}
    </Pill>
  );
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

const VERDICT_TONE: Record<DecisionVerdict, Tone> = {
  'pending-review': 'info',
  'collecting-fees': 'neutral',
  'below-minimum': 'neutral',
  'waiting-session': 'neutral',
  'waiting-signal': 'neutral',
  'venue-paused': 'warn',
  'kill-switch': 'warn',
  'daily-loss-limit': 'warn',
  'in-position': 'amber',
  'burn-only': 'amber',
  paused: 'neutral',
};

export function VerdictPill({ verdict }: { verdict: DecisionVerdict }) {
  return <Pill tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict]}</Pill>;
}

export function BiasChip({ signal }: { signal: MarketView['signal'] }) {
  if (!signal) return <Pill>No signal</Pill>;
  const { bias, score } = signal;
  const label = bias === 'long' ? '▲ Long' : bias === 'short' ? '▼ Short' : 'Wait';
  return (
    <Pill tone={bias === 'long' ? 'up' : bias === 'short' ? 'down' : 'neutral'} title={`Entry signal score ${score} of 100`}>
      {label} <span className="num">{score}</span>
    </Pill>
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
  return <Pill tone={stage === 'open' ? 'neutral' : 'amber'}>{STAGE[stage]}</Pill>;
}
