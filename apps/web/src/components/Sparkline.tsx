import { useId } from 'react';

/** A trend needs at least this many non-zero points before a line means anything. */
export const SPARK_MIN_POINTS = 7;

/**
 * Small SVG trend line. `label` is the text alternative (charts are never silent). With fewer than
 * seven non-zero points it renders `fallback` text instead: a flat line ending in a spike reads as broken.
 * `stepped` draws horizontal-then-vertical segments (cumulative burns).
 */
export function Sparkline({
  values,
  label,
  tone = 'ink',
  stepped = false,
  height = 40,
  fallback = 'Since launch',
}: {
  values: number[];
  label: string;
  tone?: 'brass' | 'ink' | 'up' | 'down';
  stepped?: boolean;
  height?: number;
  fallback?: string;
}) {
  const gradientId = `spark${useId().replace(/[^\w-]/g, '')}`;
  const width = 200;
  if (values.filter((v) => v !== 0).length < SPARK_MIN_POINTS) {
    return (
      <p className="spark spark--empty" style={{ height }}>
        {fallback}
      </p>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  let d = `M${x(0)} ${y(values[0] ?? 0)}`;
  values.forEach((v, i) => {
    if (i === 0) return;
    d += stepped ? `H${x(i)}V${y(v)}` : `L${x(i)} ${y(v)}`;
  });

  return (
    <svg className={`spark spark--${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ height }}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d}V${height}H0Z`} fill={`url(#${gradientId})`} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
