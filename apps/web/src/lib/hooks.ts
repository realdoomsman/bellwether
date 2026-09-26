import { BRAND } from '@stepup/shared';
import { useEffect, useState } from 'react';

export function useTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${BRAND.name}` : `${BRAND.name} — ${BRAND.tagline}`;
  }, [title]);
}

/** Re-render on an interval so relative timestamps ("12s ago") stay honest. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** useState mirrored to localStorage; `parse` must reject anything malformed from older versions. */
export function usePersistentState<T>(key: string, initial: T, parse: (raw: unknown) => T | null) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return (raw === null ? null : parse(JSON.parse(raw))) ?? initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or disabled (private mode): state still works for this tab.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
