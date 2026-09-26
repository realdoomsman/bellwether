const PATHS = {
  copy: <path d="M9 9h10v10H9zM5 15V5h10" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  external: <path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  flame: <path d="M12 21c-3.9 0-6.5-2.6-6.5-6 0-4 3.5-5.5 3.5-9 2 1 4.3 3.4 4.3 3.4S14 7.6 14.6 6c2.3 2 3.9 5 3.9 8.2 0 4-2.7 6.8-6.5 6.8Z" />,
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  share: <path d="M12 4v11M7.5 8.5 12 4l4.5 4.5M5 13v6h14v-6" />,
  shield: <path d="M12 3.5 5 6v5.5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9V6l-7-2.5Z" />,
  warn: <path d="M12 4 2.8 19.5h18.4L12 4ZM12 10v4.5M12 17.2v.3" />,
  wallet: <path d="M4 7.5h14.5v11H4zM4 7.5 15.5 4v3.5M15 13h.5" />,
  search: <path d="m15.5 15.5 4 4M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z" />,
  steps: <path d="M3 19h5v-4h5v-4h5V7h3" />,
  refresh: <path d="M19 12a7 7 0 1 1-2.1-5M19 4.5V9h-4.5" />,
  dot: <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, label }: { name: IconName; size?: number; className?: string; label?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name]}
    </svg>
  );
}
