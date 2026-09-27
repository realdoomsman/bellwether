import NumberFlow, { styles as flowStyles, type Format, type NumberFlowElement } from '@number-flow/react';
import { useLayoutEffect, useRef } from 'react';

/**
 * Rolling digits (NumberFlow): only changed digits roll, tabular, self-labelled for screen readers,
 * static under prefers-reduced-motion. The engine's CSP (`style-src 'self'`) blocks the <style> tag
 * NumberFlow injects into its shadow root, so the same rules are adopted as a constructed stylesheet,
 * which CSP doesn't govern.
 */
let sheet: CSSStyleSheet | null | undefined;
function adoptStyles(el: NumberFlowElement | null): void {
  const root = el?.shadowRoot;
  if (!root) return;
  if (sheet === undefined) {
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(flowStyles.join('\n'));
    } catch {
      sheet = null;
    }
  }
  if (sheet && !root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}

const TIMING = { duration: 600, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' } as const;
const OPACITY = { duration: 350, easing: 'ease-out' } as const;

export function RollingNumber({ value, format, prefix, suffix, className }: { value: number; format?: Format; prefix?: string; suffix?: string; className?: string }) {
  const ref = useRef<NumberFlowElement>(null);
  useLayoutEffect(() => adoptStyles(ref.current));
  return (
    <NumberFlow
      ref={ref}
      className={className}
      value={value}
      format={format}
      prefix={prefix}
      suffix={suffix}
      locales="en-US"
      transformTiming={TIMING}
      spinTiming={TIMING}
      opacityTiming={OPACITY}
      willChange
    />
  );
}
