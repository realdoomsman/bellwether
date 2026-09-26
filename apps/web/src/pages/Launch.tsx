import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Icon } from '../components/Icon';
import { usePersistentState, useTitle } from '../lib/hooks';
import '../styles/launch.css';
import { DRAFT_KEY, EMPTY_DRAFT, maxStep, parseDraft, STEPS, type Draft } from './launch/draft';
import { StepConfigure } from './launch/StepConfigure';
import { StepLaunch } from './launch/StepLaunch';
import { StepLaunchpad } from './launch/StepLaunchpad';
import { StepVerify } from './launch/StepVerify';
import { Summary } from './launch/Summary';

export default function Launch() {
  useTitle('Launch a token');
  const [draft, setDraft] = usePersistentState<Draft>(DRAFT_KEY, EMPTY_DRAFT, parseDraft);
  const [params, setParams] = useSearchParams();
  const allowed = maxStep(draft);
  const requested = Number(params.get('step')) || 1;
  const step = Math.min(Math.max(1, requested), allowed);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);

  // Keep the URL honest: a deep link to a step whose prerequisites are missing lands on the first open one.
  useEffect(() => {
    if (String(step) !== params.get('step')) setParams({ step: String(step) }, { replace: true });
  }, [step, params, setParams]);

  // Move focus to the step heading when the step changes (not on first load).
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    heading.current?.focus();
  }, [step]);

  const update = useCallback((patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })), [setDraft]);
  const go = (n: number) => setParams({ step: String(n) });
  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setParams({ step: '1' });
  };

  return (
    <div className="container page launch">
      <header className="page-head">
        <div>
          <p className="page-head__eyebrow">Launch</p>
          <h1>Give your token a floor</h1>
          <p>Four steps, about five minutes. You launch on the launchpad as usual — Floor only needs to be the fee recipient.</p>
        </div>
        {(draft.launchpad || draft.market) && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>
            <Icon name="refresh" /> Start over
          </button>
        )}
      </header>

      <nav aria-label="Launch steps" className="stepper">
        <ol>
          {STEPS.map((s) => {
            const state = s.n === step ? 'current' : s.n < allowed ? 'done' : s.n === allowed ? 'open' : 'locked';
            return (
              <li key={s.n} className={`stepper__item stepper__item--${state}`}>
                <button type="button" className="stepper__btn" onClick={() => go(s.n)} disabled={s.n > allowed} aria-current={s.n === step ? 'step' : undefined}>
                  <span className="stepper__num num" aria-hidden="true">
                    {state === 'done' ? <Icon name="check" size={14} /> : s.n}
                  </span>
                  <span className="stepper__label">
                    <span className="sr-only">Step {s.n}: </span>
                    {s.label}
                    {state === 'done' && <span className="sr-only"> (complete)</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="launch__grid">
        <section className="launch__panel card" aria-labelledby="step-title">
          <h2 id="step-title" ref={heading} tabIndex={-1} className="launch__title">
            <span className="launch__step num">Step {step} of 4</span>
            {STEPS[step - 1]?.label}
          </h2>
          {step === 1 && <StepLaunchpad draft={draft} update={update} next={() => go(2)} />}
          {step === 2 && <StepConfigure draft={draft} update={update} back={() => go(1)} next={() => go(3)} />}
          {step === 3 && <StepLaunch draft={draft} update={update} back={() => go(2)} next={() => go(4)} />}
          {step === 4 && <StepVerify draft={draft} update={update} back={() => go(3)} reset={reset} />}
        </section>
        <Summary draft={draft} />
      </div>
    </div>
  );
}
