import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react';
import { prefersReducedMotion } from '../lib/prefs';

/** One observer for every Reveal on the page. */
const callbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;
function watch(el: Element, onShow: () => void): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        callbacks.get(entry.target)?.();
        callbacks.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  callbacks.set(el, onShow);
  observer.observe(el);
  return () => {
    callbacks.delete(el);
    observer?.unobserve(el);
  };
}

/**
 * Fades content up 12 px (500 ms, ease-out) the first time it scrolls into view. `delay` staggers
 * siblings (use multiples of 80 ms). Reduced motion: shown immediately, no movement.
 */
export function Reveal({ as: Tag = 'div', delay = 0, className, children }: { as?: ElementType; delay?: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(prefersReducedMotion);
  useEffect(() => {
    if (shown || !ref.current) return;
    return watch(ref.current, () => setShown(true));
  }, [shown]);
  return (
    <Tag ref={ref} className={className} data-reveal={shown ? 'shown' : 'pending'} style={delay ? ({ '--reveal-delay': `${delay}ms` } as CSSProperties) : undefined}>
      {children}
    </Tag>
  );
}
