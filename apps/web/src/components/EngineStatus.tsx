import { marketSession, SESSION_LABEL, type StatusResponse } from '@bellwether/shared';
import { Link } from 'react-router';
import { relTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useStatus } from '../lib/queries';
import { useStreamState } from '../lib/stream';

type Health = 'live' | 'polling' | 'offline' | 'connecting';

export function useEngineHealth(): Health {
  const status = useStatus();
  const stream = useStreamState();
  if (!status.data) return status.error ? 'offline' : 'connecting';
  if (status.stale) return 'offline';
  return stream === 'live' ? 'live' : 'polling';
}

const HEALTH_LABEL: Record<Health, string> = {
  live: 'Live',
  polling: 'Polling',
  offline: 'Engine offline',
  connecting: 'Connecting',
};

const HEALTH_HINT: Record<Health, string> = {
  live: 'Streaming live updates from the engine',
  polling: 'Live stream reconnecting; refreshing every 15 seconds',
  offline: 'The engine is unreachable; showing last known values, marked stale, until it is back',
  connecting: 'Connecting to the engine',
};

/** Offline before anything loaded: there are no last-known values to show. */
const NEVER_LOADED_HINT = 'The engine is unreachable and nothing has loaded yet; pages fill in once it is back';

/** Compact indicator for the header. */
export function EngineIndicator() {
  const health = useEngineHealth();
  const loaded = useStatus().data !== undefined;
  const hint = health === 'offline' && !loaded ? NEVER_LOADED_HINT : HEALTH_HINT[health];
  return (
    <Link to="/app" className={`engine-ind engine-ind--${health}`} title={hint}>
      <span className="engine-ind__dot" aria-hidden="true" />
      <span>{HEALTH_LABEL[health]}</span>
      <span className="sr-only">: {hint}</span>
    </Link>
  );
}

function modeLabel(s: StatusResponse): string {
  if (s.mode === 'paper') return 'Paper';
  return s.armed ? 'Live · armed' : 'Live · read-only';
}

/** Full status strip: mode, market session, venue, kill switch, stream. */
export function EngineStatusBar() {
  const status = useStatus();
  const health = useEngineHealth();
  const s = status.data;
  const session = s?.session ?? marketSession();
  const venue = s?.venue.venues.find((v) => v.id === s.venue.active) ?? null;
  const pausedVenue = s?.venue.venues.find((v) => v.paused) ?? null;

  return (
    <dl className="statusbar">
      <div className={`statusbar__item engine-ind--${health}`}>
        <dt>Engine</dt>
        <dd>
          <span className="engine-ind__dot" aria-hidden="true" /> {HEALTH_LABEL[health]}
        </dd>
      </div>
      <div className="statusbar__item">
        <dt>Mode</dt>
        <dd>{s ? modeLabel(s) : '—'}</dd>
      </div>
      <div className="statusbar__item">
        <dt>US session</dt>
        <dd title={s ? 'As reported by the engine' : 'From your clock (engine offline)'}>{SESSION_LABEL[session]}</dd>
      </div>
      <div className="statusbar__item">
        <dt>Venue</dt>
        <dd>
          {!s ? '—' : venue ? `${venue.name}${venue.paused ? ' · paused' : ''} · up to ${venue.maxLeverage}×` : pausedVenue ? `${pausedVenue.name} · paused` : 'None active'}
        </dd>
      </div>
      <div className={`statusbar__item ${s?.killSwitch ? 'statusbar__item--alert' : ''}`}>
        <dt>Kill switch</dt>
        <dd>{!s ? '—' : s.killSwitch ? 'ON · no new entries or buybacks' : 'Off'}</dd>
      </div>
      {(venue?.pausedReason ?? pausedVenue?.pausedReason) && (
        <div className="statusbar__item statusbar__item--alert statusbar__item--wide">
          <dt>Venue notice</dt>
          <dd>{venue?.pausedReason ?? pausedVenue?.pausedReason}</dd>
        </div>
      )}
    </dl>
  );
}

/** Worker heartbeat table for the transparency-minded. */
export function WorkerList({ status }: { status: StatusResponse }) {
  const now = useNow(10_000);
  return (
    <ul className="workers">
      {status.workers.map((w) => {
        const state = w.lastError && w.consecutiveErrors > 0 ? 'error' : w.running ? 'running' : 'idle';
        return (
          <li key={w.id} className={`workers__row workers__row--${state}`}>
            <span className="workers__name">{w.label}</span>
            <span className="workers__state">{state === 'error' ? `${w.consecutiveErrors} failing` : state === 'running' ? 'running' : 'ok'}</span>
            <span className="workers__time num muted">last ok {relTime(w.lastOkAt, now)}</span>
            {state === 'error' && w.lastError && <span className="workers__err">{w.lastError}</span>}
          </li>
        );
      })}
    </ul>
  );
}
