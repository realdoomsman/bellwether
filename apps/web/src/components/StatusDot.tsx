import type { ReactNode } from 'react';

/**
 * Dot + text status, never a pill. Only non-default states deserve one.
 * live = up color, pending = brass-ink (reconnecting, pending review), offline = down, idle = ink-3.
 */
export type StatusTone = 'live' | 'pending' | 'offline' | 'idle';

export function StatusDot({ tone, children, className }: { tone: StatusTone; children?: ReactNode; className?: string }) {
  return (
    <span className={`status status--${tone}${className ? ` ${className}` : ''}`}>
      <span className="status__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
