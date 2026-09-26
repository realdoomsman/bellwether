import type { CSSProperties } from 'react';

/**
 * Split-flap display: each character is its own cell keyed by (position, char), so a changed
 * digit remounts and replays the flip animation while unchanged digits stay still.
 * Screen readers get the plain string once.
 */
export function FlapText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <span className={`flap ${className}`}>
      <span className="flap__cells" aria-hidden="true">
        {[...text].map((ch, i) => (
          <span key={`${i}:${ch}`} className={/[0-9A-Z-]/.test(ch) ? 'flap__cell' : 'flap__cell flap__cell--sep'} style={{ '--i': i } as CSSProperties}>
            {ch}
          </span>
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
