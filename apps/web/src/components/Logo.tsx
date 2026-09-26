/**
 * Floor wordmark: geometric lowercase "floor" drawn as strokes (font-independent), standing on the
 * floor line — a stepped underline that only steps up. Letters use currentColor; the line is amber.
 */
export function Wordmark({ className, title = 'Floor' }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 84 38" role="img" aria-label={title} fill="none">
      <g stroke="currentColor" strokeWidth="5">
        <path d="M5 27V9.5A5.5 5.5 0 0 1 10.5 4H14" />
        <path d="M0.5 14.5H13" />
        <path d="M20 2V27" />
        <circle cx="34.5" cy="19" r="5.5" />
        <circle cx="54" cy="19" r="5.5" />
        <path d="M68 27V11.5" />
        <path d="M68 19.5A6 6 0 0 1 74 13.5H77.5" />
      </g>
      <path d="M0 35.5H44V32.5H62V29.5H80V24" stroke="var(--amber, #FFB23F)" strokeWidth="3" strokeLinejoin="miter" />
    </svg>
  );
}

/** Square mark: four stepped bars, the floor rising. Matches public/favicon.svg. */
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
