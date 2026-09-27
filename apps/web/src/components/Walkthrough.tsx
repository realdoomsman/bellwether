import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import '../styles/walkthrough.css';
import { Muted, Section } from './Primitives';

/** Recorded from the running product (paper mode) with public/media assets; see the chapter and caption VTTs. */
const MEDIA = {
  webm: '/media/walkthrough.webm',
  mp4: '/media/walkthrough.mp4',
  posterAvif: '/media/walkthrough-poster.avif',
  posterJpg: '/media/walkthrough-poster.jpg',
  chapters: '/media/walkthrough.vtt',
  captions: '/media/walkthrough.en.vtt',
};
/** Shown until the file's own metadata arrives. */
const DURATION_S = 73.4;
const RECORDED = '27 September 2026';
const SKIP_S = 5;

interface Chapter {
  start: number;
  title: string;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** No playable source: a media error, or every <source> was tried and failed. */
function loadFailed(v: HTMLVideoElement): boolean {
  return v.error !== null || v.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
}

/** True once the element comes within ~one screen of the viewport; stays true. */
function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '100% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" className="wt__glyph">
      {children}
    </svg>
  );
}
const PLAY = <path d="M6.5 4.5v11l9-5.5z" fill="currentColor" />;
const PAUSE = <path d="M7 4.5v11M13 4.5v11" strokeWidth="2" />;
const REPLAY = <path d="M4.5 10a5.5 5.5 0 1 0 1.6-3.9M4.5 3.5v3h3" />;
const EXPAND = <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />;
const COLLAPSE = <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" />;

/**
 * The product walkthrough: a paper-mode recording of the real product on a video mat. Nothing loads
 * until the player nears the viewport (then only the poster and the two small VTTs); the video itself
 * streams on the first play. Never autoplays. Chapters and captions come from WebVTT; captions are drawn
 * in the page's own type. Keys while focus is inside: Space/K play, ←/→ 5 s, Home/End, C captions,
 * F full screen.
 */
export function Walkthrough({ className }: { className?: string }) {
  const root = useRef<HTMLElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const chaptersTrack = useRef<HTMLTrackElement>(null);
  const captionsTrack = useRef<HTMLTrackElement>(null);
  const toggleBtn = useRef<HTMLButtonElement>(null);
  const near = useNearViewport(root);

  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(DURATION_S);
  const [captions, setCaptions] = useState(true);
  const [cue, setCue] = useState<string | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [failed, setFailed] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    setCanFullscreen(document.fullscreenEnabled === true);
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null && document.fullscreenElement === player.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Near the viewport: turn both tracks on (hidden, so the browser fetches them and the page draws them).
  useEffect(() => {
    const ch = chaptersTrack.current;
    const cc = captionsTrack.current;
    if (!near || !ch || !cc) return;
    const readChapters = () => {
      const cues = ch.track.cues;
      if (!cues) return;
      const list: Chapter[] = [];
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i] as VTTCue;
        list.push({ start: c.startTime, title: c.text });
      }
      setChapters(list);
    };
    const onCue = () => {
      const active = cc.track.activeCues;
      const lines: string[] = [];
      if (active) for (let i = 0; i < active.length; i++) lines.push((active[i] as VTTCue).text);
      setCue(lines.length ? lines.join('\n') : null);
    };
    ch.track.mode = 'hidden';
    cc.track.mode = 'hidden';
    ch.addEventListener('load', readChapters);
    cc.track.addEventListener('cuechange', onCue);
    if (ch.readyState === HTMLTrackElement.LOADED) readChapters();
    return () => {
      ch.removeEventListener('load', readChapters);
      cc.track.removeEventListener('cuechange', onCue);
    };
  }, [near]);

  // Media element state → React. Source errors don't bubble, so listen in the capture phase.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onTime = () => setTime(v.currentTime);
    const onMeta = () => Number.isFinite(v.duration) && v.duration > 0 && setDuration(v.duration);
    const onPlay = () => {
      setPlaying(true);
      setEnded(false);
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setEnded(true);
    };
    const onError = () => {
      if (loadFailed(v)) {
        setFailed(true);
        setPlaying(false);
      }
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('seeked', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError, true);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('seeked', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onError, true);
    };
  }, []);

  const play = useCallback((at?: number) => {
    const v = video.current;
    if (!v) return;
    setStarted(true);
    // After a failed load, play() alone won't try the sources again.
    if (loadFailed(v)) {
      setFailed(false);
      v.load();
    }
    if (at !== undefined) {
      v.currentTime = at;
      setTime(at);
    }
    v.play().catch((e: unknown) => {
      // An interrupted play() (a pause or seek raced it) is not a failure.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setFailed(true);
      setPlaying(false);
    });
  }, []);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused || v.ended || loadFailed(v)) play();
    else v.pause();
  }, [play]);

  const seek = useCallback(
    (to: number) => {
      const v = video.current;
      if (!v) return;
      const t = Math.min(Math.max(0, to), duration);
      if (!started) {
        play(t);
        return;
      }
      v.currentTime = t;
      setTime(t);
    },
    [duration, play, started],
  );

  const fullscreen = useCallback(() => {
    const el = player.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => {});
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    const onRange = t instanceof HTMLInputElement && t.type === 'range';
    const onButton = t.tagName === 'BUTTON';
    switch (e.key) {
      case ' ':
        if (onButton) return;
        e.preventDefault();
        toggle();
        return;
      case 'k':
      case 'K':
        e.preventDefault();
        toggle();
        return;
      // The scrubber too: its native step (0.1 s) is far too fine to be useful from the keyboard.
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight': {
        const back = e.key === 'ArrowLeft' || e.key === 'ArrowDown';
        if (!onRange && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
        e.preventDefault();
        seek((video.current?.currentTime ?? 0) + (back ? -SKIP_S : SKIP_S));
        return;
      }
      case 'Home':
      case 'End':
        e.preventDefault();
        seek(e.key === 'Home' ? 0 : duration);
        return;
      case 'c':
      case 'C':
        e.preventDefault();
        setCaptions((on) => !on);
        return;
      case 'f':
      case 'F':
        if (!canFullscreen) return;
        e.preventDefault();
        fullscreen();
        return;
    }
  };

  const current = started ? chapters.findLastIndex((c) => c.start <= time + 0.05) : -1;
  const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const state = ended ? 'Replay' : playing ? 'Pause' : started ? 'Play' : 'Play the walkthrough';

  return (
    <figure ref={root} className={className ? `wt ${className}` : 'wt'}>
      <div ref={player} className="wt__player" onKeyDown={onKey}>
        <div className="wt__mat">
          <div className="wt__stage" data-started={started || undefined}>
            <video ref={video} className="wt__video" preload="none" playsInline disablePictureInPicture onClick={toggle} aria-label="Walkthrough of Bellwether, a paper-mode recording" tabIndex={-1}>
              <source src={MEDIA.mp4} type="video/mp4" />
              <source src={MEDIA.webm} type="video/webm" />
              <track ref={chaptersTrack} kind="chapters" src={MEDIA.chapters} srcLang="en" label="Chapters" />
              <track ref={captionsTrack} kind="captions" src={MEDIA.captions} srcLang="en" label="English" />
            </video>
            {/* Also back after a failed load: the poster stays, and Play retries. */}
            {(!started || failed) && (
              <button
                type="button"
                className="wt__facade"
                onClick={() => {
                  play();
                  // The facade unmounts on play; keep keyboard focus (and the shortcuts) inside the player.
                  toggleBtn.current?.focus({ preventScroll: true });
                }}
              >
                <picture>
                  <source srcSet={MEDIA.posterAvif} type="image/avif" />
                  <img src={MEDIA.posterJpg} width={1920} height={1080} alt="" loading="lazy" decoding="async" className="wt__poster" />
                </picture>
                <span className="wt__big">
                  <Glyph>{PLAY}</Glyph>
                  <span>Play</span>
                  <span className="wt__big-time num">{clock(duration)}</span>
                  <span className="sr-only">product walkthrough</span>
                </span>
              </button>
            )}
            {started && captions && cue && <p className="wt__cue">{cue}</p>}
            {failed && (
              <p className="wt__failed" role="alert">
                The video didn’t load. <a href={MEDIA.mp4}>Open the MP4</a>
              </p>
            )}
          </div>
          <div className="wt__bar">
            <button ref={toggleBtn} type="button" className="icon-btn wt__toggle" onClick={started ? toggle : () => play()} aria-label={state}>
              <Glyph>{ended ? REPLAY : playing ? PAUSE : PLAY}</Glyph>
            </button>
            <span className="wt__time num" aria-hidden="true">
              {clock(time)} <span className="wt__of">/ {clock(duration)}</span>
            </span>
            <input
              type="range"
              className="range wt__seek"
              min={0}
              max={duration}
              step={0.1}
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Seek"
              aria-valuetext={`${clock(time)} of ${clock(duration)}`}
              style={{ '--wt-p': `${progress}%` } as CSSProperties}
            />
            <button type="button" className="toggle wt__cc" aria-pressed={captions} onClick={() => setCaptions((on) => !on)}>
              Captions
            </button>
            {canFullscreen && (
              <button type="button" className="icon-btn wt__fs" onClick={fullscreen} aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}>
                <Glyph>{isFullscreen ? COLLAPSE : EXPAND}</Glyph>
              </button>
            )}
          </div>
        </div>
        <nav className="wt__side" aria-label="Walkthrough chapters">
          <p className="label">Chapters</p>
          <ol className="wt__chapters">
            {chapters.map((c, i) => (
              <li key={c.start}>
                <button type="button" className="wt__chapter" aria-current={i === current ? 'true' : undefined} onClick={() => (started ? seek(c.start) : play(c.start))}>
                  <span className="wt__ch-time num">{clock(c.start)}</span>
                  <span className="wt__ch-title">{c.title}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="wt__keys">
            <kbd>Space</kbd> play · <kbd>←</kbd>
            <kbd>→</kbd> {SKIP_S} s · <kbd>C</kbd> captions{canFullscreen && <> · <kbd>F</kbd> full screen</>}
          </p>
        </nav>
      </div>
      <figcaption className="wt__cap">
        Paper-mode recording of the real product, {RECORDED}. Prices are live from Hyperliquid; trades and burns are simulated, and it ran against a test engine: always copy the wallet address from the launch page, never from a video.
      </figcaption>
    </figure>
  );
}

/** Landing chapter: the walkthrough between "How it works" and the board. */
export function WalkthroughChapter({ n }: { n: number }) {
  return (
    <Section
      id="walkthrough"
      n={n}
      label="Walkthrough"
      className="wt-section"
      title={
        <>
          See it run. <Muted>One launch, start to finish.</Muted>
        </>
      }
      lede="The bell ringing on a burn, the live engine, a token’s page, and all four launch steps on Pons, recorded from the running product."
    >
      <Walkthrough />
    </Section>
  );
}
