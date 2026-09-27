import { useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from '../../lib/prefs';

const EASE_SNAP = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * FLIP for a re-ranked list: children marked `data-flip="<key>"` glide from their previous slot to
 * the new one (420 ms, ease-snap) whenever `order` changes; rows that weren't there before fade in.
 * Positions are offsets inside the container, so page scroll between renders doesn't read as movement.
 * Reduced motion: rows jump straight to their new place.
 */
export function useFlip(container: RefObject<HTMLElement | null>, order: string): void {
  const slots = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const previous = slots.current;
    const next = new Map<string, number>();
    const animate = previous !== null && !prefersReducedMotion();
    for (const row of root.querySelectorAll<HTMLElement>('[data-flip]')) {
      const key = row.dataset.flip ?? '';
      const top = row.offsetTop;
      next.set(key, top);
      if (!animate) continue;
      const before = previous.get(key);
      if (before === undefined) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: EASE_SNAP });
      } else if (Math.abs(before - top) > 1) {
        row.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: 420, easing: EASE_SNAP });
      }
    }
    slots.current = next;
  }, [container, order]);
}
