import { BRAND, type ActivityEvent } from '@bellwether/shared';
import { useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { strike } from '../lib/bellSound';
import { compact, eth, etTime, relTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { getPref, prefersReducedMotion } from '../lib/prefs';
import { useActivity, usePaperMode, useStats, useStatus } from '../lib/queries';
import { useSessionClock } from '../lib/session';
import { onActivity } from '../lib/stream';
import { isPaperEvent } from './activityMeta';
import { figureStatus } from './Figure';
import { Popover } from './Popover';
import { ReceiptBody } from './Receipt';
import { RollingNumber } from './RollingNumber';
import { SoundToggle } from './Toggles';

/* ── Motion ─────────────────────────────────────────────────────────────────
 * Damped pendulum: each segment eases in and out (a real swing slows at its extremes).
 * The clapper follows at 1.4x the amplitude, 60 ms late, so it visibly strikes the lip. */
const SWING = [0, 14, -10, 6, -3, 1, 0];
const SETTLE = [0, 4, -2.5, 1.2, -0.5, 0.2, 0];
const OFFSETS = [0, 0.12, 0.3, 0.48, 0.66, 0.84, 1];
const SWING_EASE = 'cubic-bezier(0.45, 0, 0.55, 1)';
const SWING_MS = 1400;
const RING_MS = 1600;
const COALESCE_MS = 1200;
const CAPTION_MS = 6000;
const DOUBLE_GAP_MS = 500;
const ANNOUNCE_GAP_MS = 15_000;
const IDLE_AFTER_MS = 30 * 60_000;

function keyframes(amps: number[], scale = 1): Keyframe[] {
  return amps.map((a, i) => ({ transform: `rotate(${(a * scale).toFixed(2)}deg)`, offset: OFFSETS[i], easing: SWING_EASE }));
}

export interface BellHandle {
  /** One strike: swing plus rings. `double` strikes twice, 500 ms apart (the opening and closing bell). */
  ring: (opts?: { tenor?: boolean; double?: boolean }) => void;
}

/* ── Engraving ──────────────────────────────────────────────────────────────
 * 320 x 300 view box. The bell hangs from a pivot bolt at (160, 44) on the beam. */
const BODY =
  'M160 64C186 64 196 72 198 92C200 114 200 140 206 170C212 200 228 216 252 226C262 230 264 236 258 240H62C56 236 58 230 68 226C92 216 108 200 114 170C120 140 120 114 122 92C124 72 134 64 160 64Z';
const HATCH_Y = Array.from({ length: 70 }, (_, i) => 66 + i * 2.5);

function BellArt({ bellRef, clapperRef, ringsRef, clipId }: { bellRef: Ref<SVGGElement>; clapperRef: Ref<SVGGElement>; ringsRef: Ref<SVGGElement>; clipId: string }) {
  return (
    <svg className="bell__art" viewBox="0 0 320 300" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clipId}>
          <path d={BODY} />
        </clipPath>
      </defs>
      <g ref={ringsRef} className="bell__rings">
        <circle cx="160" cy="160" r="96" vectorEffect="non-scaling-stroke" />
        <circle cx="160" cy="160" r="96" vectorEffect="non-scaling-stroke" />
        <circle cx="160" cy="160" r="96" vectorEffect="non-scaling-stroke" />
      </g>
      {/* Beam: engraved timber with shading on its underside */}
      <g className="bell__beam">
        <rect x="20" y="16" width="280" height="20" rx="1.5" className="bell__beam-body" />
        <path d="M26 21.5C90 20.5 150 22.5 214 21.5S284 20.8 294 21.5M26 26C80 27 140 25 200 26.2S270 27 294 26M26 30.5H294M26 33H294" className="bell__grain" />
        <path d="M36 16V36M284 16V36" className="bell__line-thin" />
        <rect x="146" y="13" width="28" height="26" rx="2" className="bell__strap" />
        <circle cx="153" cy="20" r="1.6" className="bell__rivet" />
        <circle cx="167" cy="20" r="1.6" className="bell__rivet" />
      </g>
      <g ref={clapperRef} className="bell__clapper">
        <path d="M160 80V250" className="bell__rod" />
        <circle cx="160" cy="258" r="9" className="bell__ball" />
      </g>
      <g ref={bellRef} className="bell__body">
        <path d="M155.5 39H164.5V66H155.5Z" className="bell__hanger" />
        <path d="M149 66V60A11 11 0 0 1 171 60V66" className="bell__canon" />
        <path d={BODY} className="bell__metal" />
        <g clipPath={`url(#${clipId})`}>
          {/* Right-third hatching: banknote-engraving shade */}
          <g className="bell__hatch">
            {HATCH_Y.map((y) => (
              <path key={y} d={`M${186 + (y - 66) * 0.2} ${y}H270`} />
            ))}
          </g>
          {/* Denser cross-hatch in the deepest shade, near the right edge */}
          <g className="bell__hatch bell__hatch--deep">
            {HATCH_Y.filter((_, i) => i % 2 === 0).map((y) => (
              <path key={y} d={`M${204 + (y - 66) * 0.28} ${y + 1.25}L270 ${y - 6}`} />
            ))}
          </g>
          {/* Contour lines parallel to the right edge */}
          <path className="bell__contour" d="M184 70C192 76 192 96 192 112C192 140 194 166 200 186C206 206 220 220 244 232" />
          <path className="bell__contour" d="M176 68C182 80 184 98 184 116C184 144 186 170 190 190C196 210 206 226 228 236" />
          {/* Highlight on the lit side */}
          <path className="bell__shine" d="M136 76C131 96 130 128 128 160C126 188 118 210 100 226" />
          {/* Inscription band on the shoulder, sound bow at the lip */}
          <path className="bell__band" d="M110 98C140 104 180 104 210 98M110 112C140 118 180 118 210 112" />
          <text className="bell__inscription" x="160" y="109.5" textAnchor="middle">
            {BRAND.name.toUpperCase()}
          </text>
          <path className="bell__band" d="M90 204C130 214 190 214 230 204M76 218C120 229 200 229 244 218" />
        </g>
        <path d={BODY} className="bell__outline" />
        <ellipse cx="160" cy="240" rx="98" ry="6" className="bell__mouth" />
      </g>
      <circle cx="160" cy="44" r="4.5" className="bell__bolt" />
    </svg>
  );
}

/**
 * The bell as a controlled view: art, stage button, caption, counter and controls, plus an imperative
 * `ring()`. <Bell> wires it to the engine; the /_kit page drives it with static states.
 */
export function BellView({
  ref,
  variant = 'hero',
  offline = false,
  settle = false,
  label,
  onPress,
  stageRef,
  caption,
  captionKey,
  counter,
  controls,
  announcement,
}: {
  ref?: Ref<BellHandle>;
  variant?: 'hero' | 'mini';
  offline?: boolean;
  /** One gentle 4° settle on mount (landing entry), not a ring. */
  settle?: boolean;
  label: string;
  onPress?: () => void;
  stageRef?: Ref<HTMLButtonElement>;
  caption?: ReactNode;
  /** Set while the caption is a fresh ring receipt (it rises in); changes per ring to replay the entrance. */
  captionKey?: string;
  counter?: ReactNode;
  controls?: ReactNode;
  announcement?: string;
}) {
  const bell = useRef<SVGGElement>(null);
  const clapper = useRef<SVGGElement>(null);
  const rings = useRef<SVGGElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const clipId = `bell-clip${useId().replace(/[^\w-]/g, '')}`;

  const swing = (amps: number[], withRings: boolean, tenor: boolean) => {
    if (prefersReducedMotion() || document.hidden || !bell.current || !clapper.current) return;
    for (const a of bell.current.getAnimations()) a.cancel();
    for (const a of clapper.current.getAnimations()) a.cancel();
    bell.current.animate(keyframes(amps), { duration: SWING_MS });
    clapper.current.animate(keyframes(amps, 1.4), { duration: SWING_MS, delay: 60, fill: 'backwards' });
    if (!withRings || !rings.current) return;
    root.current?.toggleAttribute('data-tenor', tenor);
    rings.current.querySelectorAll('circle').forEach((c, i) => {
      c.animate(
        [
          { transform: 'scale(0.6)', opacity: 0.55 },
          { transform: 'scale(2.6)', opacity: 0 },
        ],
        { duration: RING_MS, delay: i * 120, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' },
      );
    });
  };

  useImperativeHandle(ref, () => ({
    ring: ({ tenor = false, double = false } = {}) => {
      swing(SWING, true, tenor);
      if (double) timers.current.push(window.setTimeout(() => swing(SWING, true, tenor), DOUBLE_GAP_MS));
    },
  }));

  useEffect(() => {
    if (settle) swing(SETTLE, false, false);
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
    };
    // Mount-only: the settle plays once on first render.
  }, []);

  return (
    <div ref={root} className={`bell bell--${variant}`} data-offline={offline || undefined}>
      {/* The name starts with the engraved inscription: visible text must be part of the accessible name. */}
      <button ref={stageRef} type="button" className="bell__stage" aria-label={`${BRAND.name} bell. ${label}`} aria-haspopup="dialog" onClick={onPress}>
        <BellArt bellRef={bell} clapperRef={clapper} ringsRef={rings} clipId={clipId} />
      </button>
      {variant === 'hero' && (
        <>
          <p className={`bell__caption${captionKey ? ' is-fresh' : ''}`} key={captionKey ?? 'idle'}>
            {caption}
          </p>
          {counter && <p className="bell__counter">{counter}</p>}
          {controls && <div className="bell__controls">{controls}</div>}
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </>
      )}
    </div>
  );
}

/** Receipt line for a ring: "$GOOSE · 94.86K burned · 0.0019 ETH · 3s ago · tx ↗" (+ PAPER). */
export function RingCaption({ event, count, paper, now }: { event: ActivityEvent; count: number; paper: boolean; now: number }) {
  const tx = event.txs.find((t) => t.url && !t.hash.startsWith('paper:'));
  const simulated = paper || isPaperEvent(event);
  return (
    <>
      <span className="bell__ticker">{event.tokenSymbol ? `$${event.tokenSymbol}` : 'Burn'}</span>
      {count > 1 && <span className="bell__times">×{count}</span>}
      {event.tokensBurned !== undefined && <span className="num">{compact(event.tokensBurned)} burned</span>}
      {event.amountEth !== undefined && <span className="num">{eth(event.amountEth)}</span>}
      <span className="muted">{relTime(Math.min(event.at, now), now)}</span>
      {tx?.url && (
        <a href={tx.url} target="_blank" rel="noopener noreferrer">
          tx ↗<span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
      {simulated && <span className="paper-tag">PAPER</span>}
    </>
  );
}

/**
 * The Bell, live. Rings only for real buyback & burn events from the engine stream (coalesced to one
 * swing per 1.2 s, with a ×N count), double-strikes when the US market opens or closes, and never
 * moves otherwise. `token` limits it to one token's burns (mini bell on token pages).
 */
export function Bell({ variant = 'hero', token, settle = false }: { variant?: 'hero' | 'mini'; token?: string; settle?: boolean }) {
  const view = useRef<BellHandle>(null);
  const stage = useRef<HTMLButtonElement>(null);
  const status = useStatus();
  const stats = useStats();
  const activity = useActivity();
  const paper = usePaperMode();
  const clock = useSessionClock();
  const now = useNow(15_000);
  const [ringEvent, setRingEvent] = useState<ActivityEvent | null>(null);
  const [caption, setCaption] = useState<{ event: ActivityEvent; count: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [open, setOpen] = useState(false);
  const lastSwing = useRef(0);
  const hideTimer = useRef<number | undefined>(undefined);
  const announceQueue = useRef<ActivityEvent[]>([]);
  const announceTimer = useRef<number | undefined>(undefined);
  const lastAnnounce = useRef(0);
  const protocolToken = status.data?.protocolToken?.toLowerCase() ?? null;
  const protocolRef = useRef(protocolToken);
  protocolRef.current = protocolToken;
  const tokenKey = token?.toLowerCase();

  // Latest real burn we know of: from the stream, else from the fetched history.
  const historic = activity.data?.events.find((e) => e.kind === 'buyback' && (!tokenKey || e.token?.toLowerCase() === tokenKey)) ?? null;
  const latest = ringEvent && (!historic || ringEvent.at >= historic.at) ? ringEvent : historic;

  useEffect(() => {
    const flushAnnouncement = () => {
      announceTimer.current = undefined;
      const batch = announceQueue.current;
      announceQueue.current = [];
      const last = batch[batch.length - 1];
      if (!last || !getPref('announce')) return;
      lastAnnounce.current = Date.now();
      const what = `${last.tokenSymbol ? `$${last.tokenSymbol}` : 'a token'}${last.tokensBurned !== undefined ? `, ${compact(last.tokensBurned)} tokens` : ''}`;
      setAnnouncement(batch.length > 1 ? `${batch.length} burns in the last 15 seconds; latest ${what}.` : `Buyback and burn: ${what}.`);
    };

    return onActivity((e) => {
      if (e.kind !== 'buyback' || (tokenKey && e.token?.toLowerCase() !== tokenKey)) return;
      const tenor = protocolRef.current !== null && e.token?.toLowerCase() === protocolRef.current;
      const at = Date.now();
      setRingEvent(e);
      if (at - lastSwing.current >= COALESCE_MS) {
        lastSwing.current = at;
        view.current?.ring({ tenor });
        strike({ tenor });
      }
      setCaption((prev) => ({ event: e, count: prev ? prev.count + 1 : 1 }));
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setCaption(null), CAPTION_MS);

      announceQueue.current.push(e);
      if (announceTimer.current === undefined) {
        announceTimer.current = window.setTimeout(flushAnnouncement, Math.max(0, lastAnnounce.current + ANNOUNCE_GAP_MS - at));
      }
    });
  }, [tokenKey]);

  useEffect(
    () => () => {
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(announceTimer.current);
    },
    [],
  );

  // The opening and closing bell: a double strike when the session enters or leaves regular hours.
  const prevSession = useRef(clock.session);
  useEffect(() => {
    const prev = prevSession.current;
    prevSession.current = clock.session;
    if (variant === 'hero' && prev !== clock.session && (prev === 'regular' || clock.session === 'regular')) {
      view.current?.ring({ double: true });
      strike();
    }
  }, [clock.session, variant]);

  const offline = status.data === undefined ? Boolean(status.error) : status.stale;
  const statsState = figureStatus(stats);
  const s = stats.data;

  let idle: ReactNode;
  if (offline) idle = `Engine unreachable.${latest ? ` Last ring ${etTime(latest.at)}.` : ''}`;
  else if (!status.data || statsState === 'loading') idle = 'Connecting to the engine…';
  else if (latest && now - latest.at <= IDLE_AFTER_MS) idle = `Last ring ${relTime(Math.min(latest.at, now), now)}`;
  else if (latest) idle = `Waiting for fees · last ring ${relTime(latest.at, now)}`;
  else if (s && s.buybackCount > 0) idle = 'Waiting for the next buyback';
  else idle = 'No rings yet. The first comes with the first claimed fee.';

  const counter =
    variant === 'hero' ? (
      <>
        Rung <strong>{s ? <RollingNumber value={s.buybackCount} format={{ maximumFractionDigits: 0 }} /> : '—'}</strong> {s?.buybackCount === 1 ? 'time' : 'times'}
        <span aria-hidden="true"> · </span>
        <strong>{s ? <RollingNumber value={s.buybackEth} format={s.buybackEth >= 1 ? { minimumFractionDigits: 3, maximumFractionDigits: 3 } : { maximumSignificantDigits: 4 }} suffix=" ETH" /> : '—'}</strong>{' '}
        burned
        <span aria-hidden="true"> · </span>
        <strong>{s ? <RollingNumber value={s.burnedUsd} format={{ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }} /> : '—'}</strong>
        {paper && s && <span className="paper-tag">PAPER</span>}
      </>
    ) : undefined;

  return (
    <>
      <BellView
        ref={view}
        variant={variant}
        offline={offline}
        settle={settle}
        label={latest ? 'Show the latest burn' : 'No burn yet: show what rings the bell'}
        stageRef={stage}
        onPress={() => setOpen((v) => !v)}
        captionKey={caption ? `${caption.event.id}:${caption.count}` : undefined}
        caption={caption ? <RingCaption event={caption.event} count={caption.count} paper={paper} now={now} /> : idle}
        counter={counter}
        controls={variant === 'hero' ? <SoundToggle /> : undefined}
        announcement={announcement}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchor={stage} label={latest ? 'Latest burn' : 'How the bell rings'} className={latest ? 'popover--receipt' : undefined}>
        {latest ? (
          <div className="receipt">
            <ReceiptBody event={latest} paper={paper} />
          </div>
        ) : (
          <p className="popover__text">
            The bell rings each time the engine buys back and burns a token. Nothing has burned yet{token ? ' for this token' : ''}; the first ring comes with the first claimed fee.
          </p>
        )}
      </Popover>
    </>
  );
}
