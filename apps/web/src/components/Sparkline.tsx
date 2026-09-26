import { useId } from 'react';

/**
 * Small SVG trend line. `label` is the text alternative (required: charts are never silent).
 * `stepped` draws the floor-line style (horizontal then vertical), used for cumulative burns.
 */
export function Sparkline({
  values,
  label,
  tone = 'amber',
  stepped = false,
  height = 48,
}: {
  values: number[];
  label: string;
  tone?: 'amber' | 'up' | 'down' | 'neutral';
  stepped?: boolean;
  height?: number;
}) {
  const gradientId = `spark${useId().replace(/[^\w-]/g, '')}`;
  const width = 200;
  if (values.length < 2) {
    return (
      <div className="spark spark--empty" style={{ height }} role="img" aria-label={`${label}: not enough history yet`}>
        <span>Not enough history yet</span>
      </div>
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
  const area = `${d}V${height}H0Z`;

  return (
    <svg className={`spark spark--${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ height }}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
