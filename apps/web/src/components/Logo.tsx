import { BRAND } from '@stepup/shared';

/**
 * Stepup wordmark: geometric lowercase "stepup" drawn as strokes (font-independent), standing on the
 * stepped line — an underline that climbs a step at each word break and rises at the right. Letters use
 * currentColor; the line is amber. Same geometry as public/og.svg.
 */
export function Wordmark({ className, title = BRAND.name }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 43" role="img" aria-label={title} fill="none">
      <g stroke="currentColor" strokeWidth="4.5">
        <path d="M13 11.25H5.625A3.375 3.375 0 0 0 5.625 18H9.375A3.375 3.375 0 0 1 9.375 24.75H1.5" />
        <path d="M21 3V18.5A6.25 6.25 0 0 0 27.25 24.75H29" />
        <path d="M16.5 11.25H28.5" />
        <path d="M34.75 18H48.25A6.75 6.75 0 1 0 46.27 22.77" />
        <path d="M56.25 9V32" />
        <circle cx="63" cy="18" r="6.75" />
        <path d="M77.75 9V18A6.75 6.75 0 0 0 91.25 18" />
        <path d="M91.25 9V27" />
        <path d="M99.25 9V32" />
        <circle cx="106" cy="18" r="6.75" />
      </g>
      <path d="M0 41.5H52.25V38.5H95.25V35.5H118.5V20" stroke="var(--amber, #FFB23F)" strokeWidth="3" strokeLinejoin="miter" />
    </svg>
  );
}

/** Square mark: four stepped bars, each one a step up. Matches public/favicon.svg. */
export function Mark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#0B0B0C" />
      <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="#3B3732" />
      <g fill="#FFB23F">
        <rect x="12" y="40" width="8" height="12" />
        <rect x="22" y="32" width="8" height="20" />
        <rect x="32" y="24" width="8" height="28" />
        <rect x="42" y="14" width="8" height="38" />
      </g>
    </svg>
  );
}
