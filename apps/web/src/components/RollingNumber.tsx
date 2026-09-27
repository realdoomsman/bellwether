import type NumberFlowComponent from '@number-flow/react';
import type { Format } from '@number-flow/react';
import { useSyncExternalStore } from 'react';

/**
 * Rolling digits (NumberFlow): only changed digits roll, tabular, self-labelled for screen readers,
 * static under prefers-reduced-motion.
 *
 * NumberFlow only matters once a value changes, so it loads after the first paint (its own chunk)
 * and numbers render as plain formatted text until then, or for good if it fails to load.
 *
 * It also appends a <style> to every element's shadow root, which the engine's CSP
 * (`style-src 'self'`) refuses, logging a console error per number. So its shadow roots adopt the
 * same rules as one constructed stylesheet (CSP doesn't govern those) and never attach the <style>.
 */
const TIMING = { duration: 600, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' } as const;
const OPACITY = { duration: 350, easing: 'ease-out' } as const;

let Flow: typeof NumberFlowComponent | null = null;
const listeners = new Set<() => void>();
void import('@number-flow/react').then(
  ({ default: component, NumberFlowElement, styles }) => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(styles.join('\n'));
      const attachShadow = HTMLElement.prototype.attachShadow;
      NumberFlowElement.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
        const root = attachShadow.call(this, init);
        root.adoptedStyleSheets = [sheet];
        const append = root.appendChild.bind(root);
        root.appendChild = <T extends Node>(node: T): T => (node instanceof HTMLStyleElement ? node : append(node));
        return root;
      };
    } catch {
      // No constructable stylesheets: its styles can't apply under the CSP, so keep plain text.
      return;
    }
    Flow = component;
    for (const l of listeners) l();
  },
  () => {
    // Chunk failed to load: plain text stays.
  },
);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function RollingNumber({ value, format, prefix, suffix, className }: { value: number; format?: Format; prefix?: string; suffix?: string; className?: string }) {
  const Component = useSyncExternalStore(subscribe, () => Flow);
  if (!Component) {
    return (
      <span className={className}>
        {prefix}
        {new Intl.NumberFormat('en-US', format).format(value)}
        {suffix}
      </span>
    );
  }
  return (
    <Component
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
