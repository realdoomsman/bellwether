import { useMemo, useState } from 'react';

/** FNV-1a over the address: a stable seed so the same token always gets the same rosette. */
function seed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Ring {
  count: number;
  dist: number;
  r: number;
  turn: number;
}

/** Two rings of overlapping circles: a guilloché rosette, as on a banknote or a share certificate. */
function rosette(address: string): [Ring, Ring] {
  const h = seed(address.toLowerCase());
  const bits = (shift: number, mod: number) => (h >>> shift) % mod;
  return [
    { count: 14 + bits(0, 12), dist: 25 + bits(4, 5), r: 19 + bits(8, 4), turn: bits(12, 30) },
    { count: 7 + bits(16, 6), dist: 12 + bits(20, 4), r: 14 + bits(24, 3), turn: bits(27, 30) },
  ];
}

function ringCircles(ring: Ring, key: string) {
  return Array.from({ length: ring.count }, (_, i) => {
    const a = ((i / ring.count) * 360 + ring.turn) * (Math.PI / 180);
    return <circle key={`${key}${i}`} cx={(50 + ring.dist * Math.cos(a)).toFixed(2)} cy={(50 + ring.dist * Math.sin(a)).toFixed(2)} r={ring.r} />;
  });
}

/**
 * Token image, or a generated engraved medallion: the symbol's first letter in the serif on a guilloché
 * rosette seeded from the address. The medallion shows while the image loads or if it fails, and the box
 * is sized up front so nothing shifts.
 */
export function Medallion({ image, symbol, address, size = 36, className }: { image: string | null; symbol: string; address: string; size?: number; className?: string }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const rings = useMemo(() => rosette(address), [address]);
  const letter = symbol.replace(/^\$/, '').charAt(0).toUpperCase() || '?';
  const isLoaded = image !== null && loaded === image;
  const detailed = size >= 28;
  return (
    <span className={`medallion${isLoaded ? ' is-loaded' : ''}${className ? ` ${className}` : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg className="medallion__art" viewBox="0 0 100 100" width={size} height={size}>
        <circle cx="50" cy="50" r="49" className="medallion__disc" />
        <g className="medallion__rose" data-detailed={detailed || undefined}>
          {ringCircles(rings[0], 'a')}
          {detailed && ringCircles(rings[1], 'b')}
        </g>
        <circle cx="50" cy="50" r={detailed ? 21 : 26} className="medallion__boss" />
        <text x="50" y="50" dy="0.35em" textAnchor="middle" className="medallion__letter" fontSize={detailed ? 27 : 36}>
          {letter}
        </text>
        <circle cx="50" cy="50" r="49" className="medallion__edge" />
      </svg>
      {image && failed !== image && (
        <img
          className="medallion__img"
          src={image}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(image)}
          onError={() => setFailed(image)}
        />
      )}
    </span>
  );
}
