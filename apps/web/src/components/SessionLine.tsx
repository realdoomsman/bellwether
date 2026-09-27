import { SESSION_LABEL, STRATEGIES, STRATEGY_IDS } from '@bellwether/shared';
import { useRef, useState } from 'react';
import { useSessionClock, type SessionClock } from '../lib/session';
import { BellGlyph } from './Logo';
import { Popover } from './Popover';
import { StatusDot, type StatusTone } from './StatusDot';

const TONE: Record<SessionClock['tone'], StatusTone> = { open: 'live', extended: 'pending', closed: 'idle' };

/** What each strategy does right now, from the shared strategy config the engine runs. */
function SessionDetails({ clock }: { clock: SessionClock }) {
  return (
    <>
      <p className="popover__title">
        {clock.label} <span className="muted">· {clock.detail}</span>
      </p>
      <ul className="session-list">
        {STRATEGY_IDS.map((id) => {
          const s = STRATEGIES[id];
          const now = s.trades && s.sessions.includes(clock.session);
          return (
            <li key={id}>
              <span className="session-list__name">{s.label}</span>
              <span className={now ? 'up' : 'muted'}>
                {!s.trades ? 'Never trades; burns only' : now ? 'Can enter now' : `Waits (enters ${s.sessions.length === 5 ? 'any time' : s.sessions.map((x) => SESSION_LABEL[x]).join(', ').toLowerCase()})`}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="popover__foot">Exits and stops run in every session. Buybacks and burns never wait for the market.</p>
    </>
  );
}

/**
 * US market session, as the strategies see it: "● Market open · closes in 2h 14m" (compact: the label
 * alone, detail in the tooltip and popover). The line is a button that opens what each strategy does
 * in this session.
 */
export function SessionLine({ compact = false, className }: { compact?: boolean; className?: string }) {
  const clock = useSessionClock();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`session-line${compact ? ' session-line--compact' : ''}${className ? ` ${className}` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={compact ? `${clock.label} · ${clock.detail}` : undefined}
      >
        <StatusDot tone={TONE[clock.tone]}>
          {clock.label}
          {compact && <span className="sr-only">, {clock.detail}</span>}
        </StatusDot>
        {!compact && <span className="session-line__detail">{clock.detail}</span>}
        {!compact && <BellGlyph className="session-line__bell" />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={`US market session: ${clock.label}`} className="popover--session">
        <SessionDetails clock={clock} />
      </Popover>
    </>
  );
}
