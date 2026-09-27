import type { CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { STEPS } from './draft';

/**
 * 1 Launchpad — 2 Configure — 3 Launch — 4 Verify & register. Done steps carry a check and stay
 * clickable; steps whose prerequisites are missing are locked. One hairline runs underneath: ink up to
 * the current step, a stronger rule over steps already completed ahead of it.
 */
export function Stepper({ step, allowed, go }: { step: number; allowed: number; go: (n: number) => void }) {
  return (
    <nav className="lw-stepper" aria-label="Launch progress">
      <ol className="lw-stepper__list">
        {STEPS.map((s) => {
          const state = s.n === step ? 'current' : s.n < allowed ? 'done' : s.n === allowed ? 'open' : 'locked';
          return (
            <li key={s.n} className="lw-stepper__item" data-state={state}>
              <button type="button" className="lw-stepper__btn" onClick={() => go(s.n)} disabled={state === 'locked'} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="lw-stepper__n num" aria-hidden="true">
                  {state === 'done' ? <Icon name="check" size={14} /> : s.n}
                </span>
                <span className="lw-stepper__label">
                  <span className="sr-only">Step {s.n}: </span>
                  {s.label}
                  {state === 'done' && <span className="sr-only"> (done)</span>}
                  {state === 'locked' && <span className="sr-only"> (locked until the steps before it are done)</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="lw-stepper__rule" aria-hidden="true" style={{ '--step': step, '--reach': Math.max(step, allowed - 1) } as CSSProperties}>
        <span className="lw-stepper__reach" />
        <span className="lw-stepper__fill" />
      </div>
    </nav>
  );
}
