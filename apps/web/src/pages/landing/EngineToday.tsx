import type { ActivityEvent, ActivityKind } from '@bellwether/shared';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { eth, int } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { usePaperMode } from '../../lib/queries';
import { useSessionClock } from '../../lib/session';
import { onActivity, useStreamRefresh } from '../../lib/stream';
import { revalidate, useApi } from '../../lib/useApi';

const KEY = 'landing:today';
const PAGE = 200;
const DISMISS_KEY = 'bw:today-dismissed';
const TRADE_KINDS: Partial<Record<ActivityKind, true>> = { open: true, reduce: true, close: true, stop: true, liquidated: true };
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

interface Today {
  claims: number;
  claimedEth: number;
  burns: number;
  burnEth: number;
  trades: number;
  /** The page filled up with today's events, so counts are lower bounds. */
  more: boolean;
}

function tally(events: ActivityEvent[], now: number): Today {
  const day = ET_DAY.format(now);
  const t: Today = { claims: 0, claimedEth: 0, burns: 0, burnEth: 0, trades: 0, more: false };
  let inDay = 0;
  for (const e of events) {
    if (ET_DAY.format(e.at) !== day) continue;
    inDay += 1;
    if (e.kind === 'claim') {
      t.claims += 1;
      t.claimedEth += e.amountEth ?? 0;
    } else if (e.kind === 'buyback') {
      t.burns += 1;
      t.burnEth += e.amountEth ?? 0;
    } else if (TRADE_KINDS[e.kind]) t.trades += 1;
  }
  t.more = events.length === PAGE && inDay === PAGE;
  return t;
}

/**
 * "Engine today": a slim bar fixed to the bottom of the viewport once the reader is past the tape,
 * counting today's (ET) real claims, burns and trades. Hidden near the closing section so it never
 * sits on the footer; dismissible for the session.
 */
export function EngineToday() {
  const q = useApi(KEY, (s) => api.activity({ limit: PAGE }, s), { refreshMs: useStreamRefresh() });
  const paper = usePaperMode();
  const clock = useSessionClock();
  const now = useNow(60_000);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [shown, setShown] = useState(false);

  // New engine events: refetch the page (coalesced) so today's counts follow the stream.
  useEffect(() => {
    let timer: number | undefined;
    const off = onActivity(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => revalidate(KEY), 1_500);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);

  // Shown between the end of the tape and the closing section. Measured on scroll (one rAF, two
  // reads) against the page's sentinels, which survive route transitions and hot reloads.
  useEffect(() => {
    if (dismissed) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const start = document.querySelector('[data-today-start]');
      const end = document.querySelector('[data-today-end]');
      if (!start || !end) return;
      setShown(start.getBoundingClientRect().top < 0 && end.getBoundingClientRect().top > window.innerHeight);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [dismissed]);

  if (dismissed || !q.data) return null;
  const t = tally(q.data.events, now);
  const plus = t.more ? '+' : '';
  const items = [
    t.claims > 0 && (
      <span key="c">
        Claims <strong className="num">{int(t.claims)}{plus}</strong> <span className="ld-today__sub num">{eth(t.claimedEth)}</span>
      </span>
    ),
    t.burns > 0 && (
      <span key="b">
        Buybacks <strong className="num">{int(t.burns)}{plus}</strong> <span className="ld-today__sub num">{eth(t.burnEth)}</span>
      </span>
    ),
    t.trades > 0 && (
      <span key="t">
        Trades <strong className="num">{int(t.trades)}{plus}</strong>
      </span>
    ),
  ].filter(Boolean);
  const quiet = clock.tone === 'off' ? 'Quiet so far today. Outside US hours most strategies wait to enter; burns continue as fees arrive.' : 'Quiet so far today: no claims, burns or trades yet.';

  // Portalled: the route wrapper's entry transform would otherwise make it the fixed bar's containing block.
  return createPortal(
    <aside className="ld-today" data-shown={shown || undefined} aria-label="Engine today" aria-hidden={!shown || undefined} inert={!shown || undefined}>
      <div className="container ld-today__inner">
        <p className="ld-today__line">
          <span className="ld-today__title">
            <span className="ld-today__long">Engine today</span>
            <span className="ld-today__short" aria-hidden="true">Today</span>
          </span>
          {items.length > 0 ? items : <span className="ld-today__quiet">{quiet}</span>}
          {paper && items.length > 0 && <span className="paper-tag">PAPER</span>}
          {q.stale && <span className="ld-today__sub">(stale)</span>}
        </p>
        <Link to="/app" className="tertiary ld-today__link">
          Live <span className="arrow" aria-hidden="true">→</span>
        </Link>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Hide the engine today bar"
          onClick={() => {
            setDismissed(true);
            try {
              sessionStorage.setItem(DISMISS_KEY, '1');
            } catch {
              // Storage disabled: hidden for this page view only.
            }
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </aside>,
    document.body,
  );
}
