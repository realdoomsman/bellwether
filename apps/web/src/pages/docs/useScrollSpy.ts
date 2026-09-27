import { useEffect, useState, type RefObject } from 'react';

/** How far below the sticky header a section's top must be before it counts as the one being read. */
const READ_LINE = 64 + 96;

/**
 * Scroll-spy for a long article: the last section whose top has crossed the read line is active
 * (the final one once the page bottoms out). Reading progress through `article` is written straight
 * to `--progress` on `progressEl` (a 0..1 scale), so scrolling never re-renders the page.
 */
export function useScrollSpy(ids: readonly string[], article: RefObject<HTMLElement | null>, progressEl: RefObject<HTMLElement | null>): string {
  const [active, setActive] = useState(ids[0] ?? '');

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const sections = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let current = sections[0]?.id ?? '';
      if (atBottom && sections.length) current = sections[sections.length - 1]!.id;
      else for (const el of sections) if (el.getBoundingClientRect().top <= READ_LINE) current = el.id;
      setActive(current);

      const box = article.current?.getBoundingClientRect();
      if (box && progressEl.current) {
        const travel = box.height - (window.innerHeight - READ_LINE);
        const read = travel > 0 ? Math.min(1, Math.max(0, (READ_LINE - box.top) / travel)) : 1;
        progressEl.current.style.setProperty('--progress', read.toFixed(4));
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [ids, article, progressEl]);

  return active;
}
