import type { ActivityEvent } from '@bellwether/shared';
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { etTime } from '../lib/format';
import { useReducedMotion } from '../lib/prefs';
import { useActivity, usePaperMode } from '../lib/queries';
import { isPaperEvent, KIND_GLYPH, KIND_TONE, printAmount, printVerb, subject, TAPE_KINDS } from './activityMeta';
import { BellGlyph } from './Logo';
import { ReceiptTrigger } from './Receipt';

const TAPE_LEN = 30;
const SPEED_PX_S = 40;

/** One print: "14:03 ET · [glyph] $GOOSE burned 94.86K ↗". */
function Print({ event: e, paper, tabIndex }: { event: ActivityEvent; paper: boolean; tabIndex: number }) {
  const glyph = KIND_GLYPH[e.kind];
  const amount = printAmount(e);
  const who = subject(e);
  // The print's own text is its accessible name (visible text must be part of it); only the action is added.
  return (
    <ReceiptTrigger event={e} paper={paper} className={`print print--${KIND_TONE[e.kind]}`} tabIndex={tabIndex}>
      <time className="print__time" dateTime={new Date(e.at).toISOString()}>
        {etTime(e.at)}
      </time>
      <span className="print__glyph" aria-hidden="true">
        {glyph ?? <BellGlyph />}
      </span>
      {who && <span className="print__who">{who}</span>}
      <span className="print__verb">{printVerb(e)}</span>
      {amount && <span className="print__amt">{amount}</span>}
      {(paper || isPaperEvent(e)) && <span className="paper-tag">PAPER</span>}
      <span className="print__go" aria-hidden="true">
        ↗
      </span>
      <span className="sr-only">, open receipt</span>
    </ReceiptTrigger>
  );
}

/**
 * The Tape: a full-bleed band of real engine prints. The newest print sits in the fixed "Latest" cell;
 * the rest scroll at 40 px/s, paused on hover, focus, hidden tabs and offscreen. New prints join the
 * loop at its next iteration so the track never jumps. Reduced motion: a static scrollable list.
 */
export function Tape({ className }: { className?: string }) {
  const q = useActivity();
  const paper = usePaperMode();
  const offline = q.data === undefined ? Boolean(q.error) : q.stale;
  return <TapeView events={q.data?.events} paper={paper} offline={offline} className={className} />;
}

/**
 * The tape as a view over a list of events (newest first). `events` undefined = not loaded yet.
 * `still` forces the static list (what reduced-motion visitors get).
 */
export function TapeView({
  events,
  paper,
  offline = false,
  still = false,
  className,
  label = 'The tape: recent engine activity',
}: {
  events: ActivityEvent[] | undefined;
  paper: boolean;
  offline?: boolean;
  still?: boolean;
  className?: string;
  /** Landmark name; must be unique when several tapes share a page (the kit). */
  label?: string;
}) {
  const reduced = useReducedMotion() || still;
  const band = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const firstCopy = useRef<HTMLUListElement>(null);
  const [visible, setVisible] = useState(true);
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const [loop, setLoop] = useState<{ width: number; overflow: boolean }>({ width: 0, overflow: false });

  const incoming = (events ?? []).filter((e) => TAPE_KINDS[e.kind]).slice(0, TAPE_LEN);
  const [shown, setShown] = useState(incoming);
  const incomingKey = incoming.map((e) => e.id).join(',');
  const shownKey = shown.map((e) => e.id).join(',');
  const pending = incomingKey !== shownKey;
  const running = !reduced && loop.overflow && shown.length > 0;

  // Without a running loop there's no iteration to wait for: take new prints at once.
  useEffect(() => {
    if (pending && !running) setShown(incoming);
    // `incoming` is a fresh array each render; its identity is `incomingKey`.
  }, [pending, running, incomingKey]);

  useLayoutEffect(() => {
    const el = firstCopy.current;
    const host = band.current;
    if (!el || !host) return;
    const measure = () => {
      const width = el.scrollWidth;
      setLoop((prev) => {
        const overflow = width > host.clientWidth * 0.8;
        return prev.width === width && prev.overflow === overflow ? prev : { width, overflow };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(host);
    return () => ro.disconnect();
  }, [shownKey]);

  useEffect(() => {
    const el = band.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true));
    io.observe(el);
    const onVis = () => setPageHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const newest = incoming[0];
  const history = shown.slice(newest && shown[0]?.id === newest.id ? 1 : 0);

  // One tab stop for the whole tape (roving tabindex): arrow keys, Home and End move between prints,
  // so a keyboard user isn't walked through 30 prints to get past it.
  const [active, setActive] = useState(0);
  const printCount = (newest ? 1 : 0) + history.length;
  const current = Math.min(active, Math.max(0, printCount - 1));
  const stop = (i: number) => (i === current ? 0 : -1);
  const prints = () => [...(band.current?.querySelectorAll<HTMLElement>('.tape__latest .print, .tape__list:not([aria-hidden]) .print') ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const all = prints();
    const i = all.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const keys: Record<string, number> = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 };
    const next = keys[e.key];
    if (next === undefined) return;
    e.preventDefault();
    all[Math.max(0, Math.min(all.length - 1, next))]?.focus();
  };
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const i = prints().indexOf(e.target as HTMLElement);
    if (i >= 0) setActive(i);
  };

  let empty: string | null = null;
  if (!events) empty = offline ? 'Paused. Engine unreachable.' : 'Connecting to the engine…';
  else if (incoming.length === 0) empty = 'No engine activity yet. Claims, trades and burns print here as they happen.';

  return (
    <section
      ref={band}
      className={`tape${className ? ` ${className}` : ''}`}
      aria-label={`${label}. Arrow keys move between prints.`}
      data-offline={offline || undefined}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <Link to="/app#activity" className="skip-link">
        Recent activity, as a list
      </Link>
      <div className="tape__latest">
        <span className="tape__label">{offline ? 'Paused' : 'Latest'}</span>
        {newest ? (
          <div className="tape__latest-print" key={newest.id}>
            <Print event={newest} paper={paper} tabIndex={stop(0)} />
          </div>
        ) : (
          <span className="tape__empty">{empty}</span>
        )}
      </div>
      {/* Reduced motion makes the history a scrollable list: it takes focus so it can be scrolled by keyboard. */}
      <div className="tape__window" {...(reduced && history.length > 0 ? { tabIndex: 0, role: 'region', 'aria-label': 'Earlier prints' } : {})}>
        {history.length > 0 && (
          <div
            ref={track}
            className={`tape__track${running ? ' is-running' : ''}`}
            data-paused={!visible || pageHidden || offline || undefined}
            style={running ? { animationDuration: `${Math.max(20, loop.width / SPEED_PX_S)}s` } : undefined}
            onAnimationIteration={() => {
              if (pending) setShown(incoming);
            }}
          >
            <ul ref={firstCopy} className="tape__list" aria-label="Recent prints">
              {history.map((e, i) => (
                <li key={e.id}>
                  <Print event={e} paper={paper} tabIndex={stop(i + (newest ? 1 : 0))} />
                </li>
              ))}
            </ul>
            {running && (
              <ul className="tape__list" aria-hidden="true" inert>
                {history.map((e) => (
                  <li key={e.id}>
                    <Print event={e} paper={paper} tabIndex={-1} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
