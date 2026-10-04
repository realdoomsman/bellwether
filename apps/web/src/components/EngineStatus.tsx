import { SESSION_LABEL, STRATEGIES, STRATEGY_IDS, type StatusResponse } from '@bellwether/shared';
import { Link } from 'react-router';
import { etTime, relTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useStatus } from '../lib/queries';
import { useSessionClock } from '../lib/session';
import { useStreamState } from '../lib/stream';
import { StatusDot, type StatusTone } from './StatusDot';

export type Health = 'live' | 'polling' | 'offline' | 'connecting';

export function useEngineHealth(): Health {
  const status = useStatus();
  const stream = useStreamState();
  if (!status.data) return status.error ? 'offline' : 'connecting';
  if (status.stale) return 'offline';
  return stream === 'live' ? 'live' : 'polling';
}

export const HEALTH_LABEL: Record<Health, string> = {
  live: 'Live',
  polling: 'Reconnecting…',
  offline: 'Offline',
  connecting: 'Connecting…',
};

export const HEALTH_TONE: Record<Health, StatusTone> = {
  live: 'live',
  polling: 'pending',
  offline: 'offline',
  connecting: 'idle',
};

const HEALTH_HINT: Record<Health, string> = {
  live: 'Streaming live updates from the engine',
  polling: 'Live stream reconnecting; refreshing every 15 seconds meanwhile',
  offline: 'The engine is unreachable; showing last known values until it is back',
  connecting: 'Connecting to the engine',
};

/** Header indicator: dot + one word. Links to the live dashboard. */
export function EngineIndicator({ className }: { className?: string }) {
  const health = useEngineHealth();
  return (
    <Link to="/app" className={`engine-ind${className ? ` ${className}` : ''}`} title={HEALTH_HINT[health]}>
      <StatusDot tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</StatusDot>
      <span className="sr-only">: {HEALTH_HINT[health]}</span>
    </Link>
  );
}

function modeLabel(s: StatusResponse): string {
  if (s.mode === 'paper') return 'Paper';
  return s.armed ? 'Live, armed' : 'Live, read-only';
}

/** Which strategies may open new positions in the current session, in words ("Steady waits for regular hours"). */
export function sessionPolicy(session: StatusResponse['session']): string {
  const waiting = STRATEGY_IDS.filter((id) => STRATEGIES[id].trades && !STRATEGIES[id].sessions.includes(session));
  if (waiting.length === 0) return 'every strategy can enter';
  const regularOnly = waiting.every((id) => STRATEGIES[id].sessions.length === 1 && STRATEGIES[id].sessions[0] === 'regular');
  return `${waiting.map((id) => STRATEGIES[id].label).join(' and ')} ${waiting.length > 1 ? 'wait' : 'waits'} for ${regularOnly ? 'regular hours' : 'US hours'}`;
}

/** A paused venue in words: the engine writes its pause reasons for the public, so they're shown as written. */
function VenueNotice({ reason }: { reason: string }) {
  return <span className="down">{reason}</span>;
}

/** One status line for the live dashboard: engine, mode, session, venue, kill switch. */
export function EngineStatusBar() {
  const status = useStatus();
  const health = useEngineHealth();
  const clock = useSessionClock();
  const s = status.data;
  const venue = s?.venue.venues.find((v) => v.id === s.venue.active) ?? null;
  const pausedVenue = s?.venue.venues.find((v) => v.paused) ?? null;
  const notice = venue?.pausedReason ?? pausedVenue?.pausedReason ?? null;

  return (
    <div className="statusline" role="group" aria-label="Engine status">
      <StatusDot tone={HEALTH_TONE[health]}>{health === 'live' ? 'Engine running' : health === 'offline' ? 'Engine unreachable' : HEALTH_LABEL[health]}</StatusDot>
      <span>{s ? modeLabel(s) : '—'}</span>
      <span>
        {SESSION_LABEL[clock.session]} <span className="muted">(perps trade 24/7; {sessionPolicy(clock.session)})</span>
      </span>
      <span>
        Venue: {!s ? '—' : venue ? `${venue.name}${venue.paused ? ', paused' : ''}` : pausedVenue ? `${pausedVenue.name}, paused` : 'none active'}
      </span>
      <span className={s?.killSwitch ? 'down' : undefined}>Kill switch {!s ? '—' : s.killSwitch ? 'on: no new entries or buybacks' : 'off'}</span>
      {notice && <VenueNotice reason={notice} />}
    </div>
  );
}

/** Worker heartbeat table for the transparency-minded. */
export function WorkerList({ status }: { status: StatusResponse }) {
  const now = useNow(10_000);
  return (
    // Scrollable on narrow screens, so it takes focus (keyboard scrolling) and needs a name.
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Engine workers">
      <table className="table">
        <caption className="sr-only">Engine workers</caption>
        <thead>
          <tr>
            <th scope="col">Worker</th>
            <th scope="col">Status</th>
            <th scope="col" className="r">
              Last run
            </th>
            <th scope="col" className="r">
              Next run
            </th>
          </tr>
        </thead>
        <tbody>
          {status.workers.map((w) => {
            const failing = w.lastError !== null && w.consecutiveErrors > 0;
            return (
              <tr key={w.id}>
                <th scope="row">{w.label}</th>
                <td>
                  {failing ? (
                    <StatusDot tone="offline">
                      {w.consecutiveErrors} failing <span className="muted">· {w.lastError}</span>
                    </StatusDot>
                  ) : w.running ? (
                    <StatusDot tone="live">Running</StatusDot>
                  ) : (
                    <span className="muted">OK</span>
                  )}
                </td>
                <td className="r num nowrap" title={w.lastOkAt ? etTime(w.lastOkAt) : undefined}>
                  {relTime(w.lastRunAt, now)}
                </td>
                <td className="r num nowrap">{relTime(w.nextRunAt, now)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
