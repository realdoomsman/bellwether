import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom';
interface Placement {
  top: number;
  left: number;
  side: Side;
}

const GAP = 8;
const MARGIN = 12;

/**
 * Keeps a fixed-position panel next to its anchor: below by default, flipped above when there's no room,
 * clamped inside the viewport. Re-measures on scroll and resize while open.
 */
export function useAnchoredPosition(anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, open: boolean, prefer: Side = 'bottom') {
  const [pos, setPos] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const roomBelow = vh - a.bottom - GAP - MARGIN;
      const roomAbove = a.top - GAP - MARGIN;
      const side: Side = prefer === 'bottom' ? (roomBelow >= h || roomBelow >= roomAbove ? 'bottom' : 'top') : roomAbove >= h || roomAbove >= roomBelow ? 'top' : 'bottom';
      const top = side === 'bottom' ? a.bottom + GAP : a.top - GAP - h;
      const left = Math.min(Math.max(MARGIN, a.left + a.width / 2 - w / 2), vw - w - MARGIN);
      setPos((prev) => (prev && prev.top === top && prev.left === left && prev.side === side ? prev : { top, left, side }));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [open, anchor, panel, prefer]);
  return pos;
}

/**
 * Non-modal popover (receipts, session details): portal to <body>, Escape or an outside click closes it
 * and focus returns to the anchor. Focus moves into the panel on open so it can be read and tabbed.
 */
export function Popover({
  open,
  onClose,
  anchor,
  label,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(anchor, panel, open);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const anchorEl = anchor.current;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
      anchorEl?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchorEl?.contains(t)) return;
      close.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={`popover${className ? ` ${className}` : ''}`}
      data-side={pos?.side ?? 'bottom'}
      data-ready={pos ? '' : undefined}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0 }}
      onBlur={(e) => {
        // Tabbing out of the panel (not into the anchor) closes it, like a disclosure.
        const next = e.relatedTarget as Node | null;
        if (next && !panel.current?.contains(next) && !anchor.current?.contains(next)) close.current();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
