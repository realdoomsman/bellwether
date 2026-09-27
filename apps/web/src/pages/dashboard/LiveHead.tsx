import { useId, useState } from 'react';
import { Bell } from '../../components/Bell';
import { EngineStatusBar, WorkerList } from '../../components/EngineStatus';
import { Icon } from '../../components/Icon';
import { etDateTime, relTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useStatus } from '../../lib/queries';

/**
 * "Live" and one status line (engine, mode, session, venue, kill switch). "Details" opens the worker
 * heartbeat table. The mini bell swings on every real burn and opens the latest receipt.
 */
export function LiveHead() {
  const status = useStatus();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const id = useId();
  const s = status.data;

  return (
    <header className="live-head">
      <div className="live-head__top">
        <div className="live-head__titles">
          <h1 className="live-head__title">Live</h1>
          <p className="live-head__lede">Every claim, trade and burn the engine makes, as it makes them.</p>
        </div>
        <Bell variant="mini" />
      </div>
      <div className="live-head__status">
        <EngineStatusBar />
        {s && (
          <button type="button" className="live-head__details" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
            Details <Icon name="chevronDown" size={14} />
          </button>
        )}
      </div>
      <div className="fold live-head__workers" id={id} data-open={open || undefined}>
        <div>
          {s && (
            <div className="live-head__panel">
              <WorkerList status={s} />
              <p className="live-head__meta">
                Engine version <span className="num">{s.version}</span> · running since <time dateTime={new Date(s.startedAt).toISOString()}>{etDateTime(s.startedAt)}</time> ({relTime(s.startedAt, now).replace(' ago', '')})
              </p>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
