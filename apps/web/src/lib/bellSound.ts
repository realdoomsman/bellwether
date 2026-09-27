import { getPref, setPref } from './prefs';

/**
 * Synthesized bell tone (additive partials, no audio files). Opt-in and off by default: the
 * AudioContext is only created from a user gesture, and strikes are rate-limited to one per 3 s.
 */
const PARTIALS: readonly (readonly [ratio: number, amp: number, decay: number])[] = [
  [0.5, 0.25, 2.4],
  [1, 1, 1.8],
  [1.2, 0.5, 1.2],
  [1.5, 0.35, 0.9],
  [2, 0.4, 0.8],
  [2.5, 0.2, 0.6],
  [3, 0.15, 0.5],
];
const TREBLE_HZ = 523.25; // C5
const TENOR_HZ = 261.63; // C4, the $BELL burn
const MIN_GAP_MS = 3_000;

let ctx: AudioContext | null = null;
let lastStrike = 0;

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

// A persisted "sound on" can't start audio after a reload until the visitor interacts with the page.
if (typeof window !== 'undefined' && getPref('sound')) {
  const unlock = () => {
    if (getPref('sound')) void ensureContext()?.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

/** Toggle handler: must be called from the click so the browser allows audio. */
export function setBellSound(on: boolean): void {
  setPref('sound', on);
  if (on) void ensureContext()?.resume();
  else void ctx?.suspend();
}

export function strike({ tenor = false, gain = 0.08 }: { tenor?: boolean; gain?: number } = {}): void {
  if (!getPref('sound') || !ctx || ctx.state !== 'running') return;
  const nowMs = performance.now();
  if (nowMs - lastStrike < MIN_GAP_MS) return;
  lastStrike = nowMs;
  const f0 = tenor ? TENOR_HZ : TREBLE_HZ;
  const out = ctx.createGain();
  out.gain.value = gain;
  out.connect(ctx.destination);
  const t = ctx.currentTime;
  for (const [ratio, amp, decay] of PARTIALS) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = f0 * ratio;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(amp, t + 0.004);
    env.gain.exponentialRampToValueAtTime(1e-4, t + decay);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}
