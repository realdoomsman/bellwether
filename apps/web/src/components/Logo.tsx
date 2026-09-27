import { BRAND } from '@bellwether/shared';
import { useId } from 'react';

/**
 * The candle-bell: a bell cast from a chart candle. The body is the candle (8 units at the crown,
 * 12 at the mouth, 12 tall on a 24 grid), the upper wick is the hanger and the lower wick ends in a
 * 3-unit brass clapper. Same geometry as public/favicon.svg. At >= 64 px it gets engraved hatching.
 */
const BODY = 'M6 18C7.3 16.4 7.8 13.8 8 11V9.6C8 7.6 9.8 6 12 6s4 1.6 4 3.6V11c.2 2.8.7 5.4 2 7Z';

export function Monogram({ size = 24, className, clapper = 'var(--brass)' }: { size?: number; className?: string; clapper?: string }) {
  const clip = useId();
  const engraved = size >= 64;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 1.5V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d={BODY} fill="currentColor" />
      {engraved && (
        <>
          <clipPath id={clip}>
            <path d={BODY} />
          </clipPath>
          <g clipPath={`url(#${clip})`} stroke="var(--paper)" strokeWidth="0.32">
            {[10, 11, 12, 13, 14, 15].map((y) => (
              <path key={y} d={`M13.6 ${y}H19`} />
            ))}
          </g>
        </>
      )}
      <path d="M5 18.1H19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 18.5V20" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="21.5" r="1.5" fill={clapper} />
    </svg>
  );
}

/** "Bellwether" set in the display serif (weight 380, -0.015em). */
export function Wordmark({ className }: { className?: string }) {
  return <span className={className ? `wordmark ${className}` : 'wordmark'}>{BRAND.name}</span>;
}

/** Monogram + wordmark, as used in the header. */
export function Lockup({ size = 22 }: { size?: number }) {
  return (
    <span className="lockup">
      <Monogram size={size} className="lockup__mark" />
      <Wordmark />
    </span>
  );
}

/** Inline bell glyph for running text and prints ("Every burn rings [bell]"); inherits color. */
export function BellGlyph({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      className={className ? `bell-glyph ${className}` : 'bell-glyph'}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d="M12 2.5V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d={BODY} fill="currentColor" />
      <path d="M5 18.1H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="21.3" r="1.7" fill="currentColor" />
    </svg>
  );
}
