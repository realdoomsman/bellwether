import { BRAND } from '@bellwether/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Muted } from '../components/Primitives';
import { usePersistentState, useTitle } from '../lib/hooks';
import { useReducedMotion } from '../lib/prefs';
import { useConfig } from '../lib/queries';
import '../styles/launch.css';
import { DRAFT_KEY, EMPTY_DRAFT, maxStep, parseDraft, type Draft } from './launch/draft';
import { StepConfigure } from './launch/StepConfigure';
import { StepHeadingRef } from './launch/StepFrame';
import { Stepper } from './launch/Stepper';
import { StepLaunch } from './launch/StepLaunch';
import { StepLaunchpad } from './launch/StepLaunchpad';
import { StepVerify, type VerifiedToken } from './launch/StepVerify';
import { Ticket } from './launch/Ticket';
import { WalletNotLive } from './launch/WalletNotLive';

/** Outgoing step fades for this long before the next one rises in (DESIGN.md: fades 120 ms, entries 240 ms). */
const LEAVE_MS = 120;

export default function Launch() {
  useTitle('Launch a token');
  const [draft, setDraft] = usePersistentState<Draft>(DRAFT_KEY, EMPTY_DRAFT, parseDraft);
  const [params, setParams] = useSearchParams();
  const config = useConfig();
  const reduced = useReducedMotion();
  const [verified, setVerified] = useState<VerifiedToken | null>(null);
  // null while unknown: only a loaded config without a wallet puts launching on hold.
  const walletLive = config.data ? config.data.protocolWallet !== null : null;
  const allowed = walletLive === false ? Math.min(maxStep(draft), 2) : maxStep(draft);
  const requested = Number(params.get('step')) || 1;
  const step = Math.min(Math.max(1, requested), allowed);

  // Keep the URL honest: a deep link to a step whose prerequisites are missing lands on the first open one.
  useEffect(() => {
    if (String(step) !== params.get('step')) setParams({ step: String(step) }, { replace: true });
  }, [step, params, setParams]);

  const update = useCallback((patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })), [setDraft]);

  // A registration is the end of one launch: only step 4 shows it. Back in steps 1-3 the creator is
  // configuring the next token, which needs its own launch confirmation and address.
  useEffect(() => {
    if (step !== 4 && draft.registered) update({ registered: null, walletConfirmed: false, address: '' });
  }, [step, draft.registered, update]);

  const go = (n: number) => setParams({ step: String(n) });
  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setVerified(null);
    setParams({ step: '1' });
  };

  // Step transition: the outgoing step fades, then the incoming one rises in from the direction of travel.
  const [view, setView] = useState({ step, dir: 'fwd' as 'fwd' | 'back', leaving: false });
  useEffect(() => {
    if (view.step === step) return;
    const dir = step > view.step ? 'fwd' : 'back';
    if (reduced) {
      setView({ step, dir, leaving: false });
      return;
    }
    setView((v) => ({ ...v, leaving: true }));
    const t = window.setTimeout(() => setView({ step, dir, leaving: false }), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [step, view.step, reduced]);

  // After each transition (not on first load), move focus to the new step's heading and bring its top into view.
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const shown = useRef(view.step);
  useEffect(() => {
    if (shown.current === view.step) return;
    shown.current = view.step;
    heading.current?.focus({ preventScroll: true });
    const top = panel.current?.getBoundingClientRect().top;
    const header = 64 + 24;
    if (top !== undefined && (top < header || top > window.innerHeight * 0.5)) {
      window.scrollTo({ top: window.scrollY + top - header, behavior: reduced ? 'auto' : 'smooth' });
    }
  }, [view.step, reduced]);

  const wallet = config.data?.protocolWallet ?? null;
  const ticket = { draft, verified, wallet, onReset: reset };

  return (
    <div className="container page lw">
      <header className="lw-top">
        <h1 className="lw-top__h1">
          Launch a token. <Muted>{BRAND.tagline}</Muted>
        </h1>
        <p className="lead lw-top__lead">
          Four steps, about five minutes. You launch on Pons or LaunchHood as you normally would; {BRAND.name} only needs to be the fee recipient.
        </p>
      </header>

      {walletLive === false && <WalletNotLive />}

      <Stepper step={step} allowed={allowed} go={go} />

      <div className="lw-grid">
        <Ticket variant="fold" {...ticket} />
        <section ref={panel} className="lw-panel" aria-labelledby="lw-step-title">
          <StepHeadingRef.Provider value={heading}>
            <div key={view.step} className="lw-stage" data-dir={view.dir} data-leaving={view.leaving || undefined}>
              {view.step === 1 && <StepLaunchpad draft={draft} update={update} next={() => go(2)} />}
              {view.step === 2 && <StepConfigure draft={draft} update={update} back={() => go(1)} next={() => go(3)} walletLive={walletLive} />}
              {view.step === 3 && <StepLaunch draft={draft} update={update} back={() => go(2)} next={() => go(4)} />}
              {view.step === 4 && <StepVerify draft={draft} update={update} back={() => go(3)} reset={reset} onVerified={setVerified} />}
            </div>
          </StepHeadingRef.Provider>
        </section>
        <Ticket variant="aside" {...ticket} />
      </div>
    </div>
  );
}
