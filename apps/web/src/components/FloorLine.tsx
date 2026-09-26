/** Decorative floor line: a stepped path that only ever steps up. Draws in once, then rests. */
export function FloorLine({ steps = 6, className = '' }: { steps?: number; className?: string }) {
  const w = 1200;
  const h = 80;
  const stepW = w / steps;
  const rise = (h - 8) / (steps - 1);
  let d = `M0 ${h - 4}`;
  for (let i = 1; i < steps; i++) d += `H${i * stepW}V${h - 4 - rise * i}`;
  d += `H${w}`;
  return (
    <svg className={`floorline ${className}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} pathLength={1} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
