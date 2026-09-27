import { useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from '../../lib/prefs';

/**
 * FLIP for a re-sorted or re-filtered list: children marked `data-flip="<id>"` inside `root` glide from
 * where they were to where they are (420 ms, --ease-snap); rows that just appeared fade in. Runs only
 * when `order` changes, so live value updates never move anything. Reduced motion: no animation.
 */
export function useFlip(root: RefObject<HTMLElement | null>, order: string): void {
  const last = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top;
    const next = new Map<string, number>();
    const items = el.querySelectorAll<HTMLElement>('[data-flip]');
    for (const item of items) next.set(item.dataset.flip ?? '', item.getBoundingClientRect().top - base);
    const prev = last.current;
    last.current = next;
    if (!prev || prefersReducedMotion()) return;
    for (const item of items) {
      const was = prev.get(item.dataset.flip ?? '');
      const now = next.get(item.dataset.flip ?? '') ?? 0;
      if (was === undefined) {
        item.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      } else if (was !== now) {
        item.animate([{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
      }
    }
  }, [order, root]);
}
