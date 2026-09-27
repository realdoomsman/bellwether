import { createContext, useContext, useId, type ReactNode, type RefObject } from 'react';
import { Icon } from '../../components/Icon';

/** The wizard moves focus to the current step's heading after each transition; steps render it through this. */
export const StepHeadingRef = createContext<RefObject<HTMLHeadingElement | null> | null>(null);

export function StepHead({ n, kicker, title, lede }: { n: number; kicker?: ReactNode; title: ReactNode; lede?: ReactNode }) {
  const ref = useContext(StepHeadingRef);
  return (
    <header className="lw-head">
      <p className="label lw-head__kicker">{kicker ?? `Step ${n} of 4`}</p>
      <h2 id="lw-step-title" ref={ref} tabIndex={-1} className="lw-head__title">
        {title}
      </h2>
      {lede && <p className="lw-head__lede">{lede}</p>}
    </header>
  );
}

/**
 * Back / Continue for a step. Continue is the step form's submit button, so Enter anywhere in the step
 * advances once it's allowed. `why` explains a disabled Continue in words and describes the button.
 */
export function StepNav({
  onBack,
  next = 'Continue',
  arrow = true,
  canNext,
  why,
  busy = false,
}: {
  onBack?: () => void;
  next?: ReactNode;
  arrow?: boolean;
  canNext: boolean;
  why?: ReactNode;
  busy?: boolean;
}) {
  const whyId = useId();
  return (
    <div className="lw-nav">
      {onBack ? (
        <button type="button" className="btn btn--ghost lw-nav__back" onClick={onBack}>
          <Icon name="arrowLeft" /> Back
        </button>
      ) : (
        <span />
      )}
      <div className="lw-nav__next">
        {why && !canNext ? (
          <p className="lw-nav__why" id={whyId}>
            {why}
          </p>
        ) : (
          canNext &&
          !busy && (
            <p className="lw-nav__kbd" aria-hidden="true">
              <kbd>Enter</kbd>
            </p>
          )
        )}
        <button type="submit" className="btn btn--primary btn--lg" disabled={!canNext || busy} aria-describedby={why && !canNext ? whyId : undefined}>
          {next}
          {arrow && !busy && <Icon name="arrowRight" />}
        </button>
      </div>
    </div>
  );
}
