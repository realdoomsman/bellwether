import { useSyncExternalStore } from 'react';

/**
 * Small persisted UI preferences shared across the app (theme, bell sound, burn announcements).
 * The theme is applied before first paint by public/theme.js; this module keeps it in sync after that.
 */
export type Theme = 'paper' | 'after-hours';
export type BoolPref = 'sound' | 'announce';

const THEME_KEY = 'bw:theme';
const PREF_KEY: Record<BoolPref, string> = { sound: 'bw:sound', announce: 'bw:announce' };
const THEME_COLOR: Record<Theme, string> = { paper: '#F5F2EA', 'after-hours': '#0E0D0B' };

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage full: the preference still applies to this tab.
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'after-hours' ? 'after-hours' : 'paper';
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  emit();
}

/** An explicit choice persists and stops following the system setting. */
export function setTheme(theme: Theme): void {
  write(THEME_KEY, theme);
  applyTheme(theme);
}

// Until the visitor chooses, follow the system setting live.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const stored = read(THEME_KEY);
    if (stored !== 'paper' && stored !== 'after-hours') applyTheme(e.matches ? 'after-hours' : 'paper');
  });
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme);
}

const boolCache: Partial<Record<BoolPref, boolean>> = {};

export function getPref(pref: BoolPref): boolean {
  return (boolCache[pref] ??= read(PREF_KEY[pref]) === '1');
}

export function setPref(pref: BoolPref, on: boolean): void {
  boolCache[pref] = on;
  write(PREF_KEY[pref], on ? '1' : '0');
  emit();
}

export function usePref(pref: BoolPref): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => getPref(pref));
  return [value, (on) => setPref(pref, on)];
}

const REDUCED = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

export function prefersReducedMotion(): boolean {
  return REDUCED?.matches ?? false;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (l) => {
      REDUCED?.addEventListener('change', l);
      return () => REDUCED?.removeEventListener('change', l);
    },
    prefersReducedMotion,
  );
}
