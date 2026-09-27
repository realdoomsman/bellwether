import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Tape } from '../components/Tape';
import { useTitle } from '../lib/hooks';
import '../styles/landing.css';
import { Hero } from './landing/Hero';

let chaptersReady = false;
const loadChapters = () =>
  import('./landing/Chapters').then((m) => {
    chaptersReady = true;
    return m;
  });
const Chapters = lazy(loadChapters);

/**
 * The chapters below the tape are their own chunk, so the first paint ships only the hero. The
 * chunk is fetched once its placeholder comes within two screens of the viewport (at once on most
 * screens), straight away for a deep link, and rendered synchronously once it's been loaded (a
 * return visit keeps its scroll position). The placeholder holds a screen of height so the footer
 * never shows through while it loads.
 */
function BelowTheFold() {
  const { hash } = useLocation();
  const [near, setNear] = useState(() => chaptersReady || hash.length > 1);
  const hold = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (near || !hold.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '0px 0px 200% 0px' });
    io.observe(hold.current);
    return () => io.disconnect();
  }, [near]);

  const placeholder = <div ref={hold} className="ld__hold" />;
  if (!near) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <Chapters />
    </Suspense>
  );
}

export default function Landing() {
  useTitle(null);
  return (
    <div className="ld">
      <Hero />
      <Tape className="ld__tape" />
      <div className="ld__after-tape" data-today-start aria-hidden="true" />
      <BelowTheFold />
    </div>
  );
}
