import { BRAND, LAUNCHPADS, type LaunchpadInfo } from '@bellwether/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorNotice } from '../../components/DataState';
import { ExtLink } from '../../components/Links';
import { useReducedMotion } from '../../lib/prefs';
import { useConfig } from '../../lib/queries';
import type { Draft } from './draft';
import { FieldPlate } from './FieldPlate';
import { launchFeeText } from './LaunchpadMark';
import { StepHead, StepNav } from './StepFrame';
import { WalletCopy } from './WalletCopy';

export function StepLaunch({ draft, update, back, next }: { draft: Draft; update: (p: Partial<Draft>) => void; back: () => void; next: () => void }) {
  const config = useConfig();
  const [copied, setCopied] = useState(false);
  const lp = draft.launchpad ? LAUNCHPADS[draft.launchpad] : null;
  if (!lp) return null;
  const wallet = config.data?.protocolWallet ?? null;
  const edges = wallet ? { head: wallet.slice(0, 6), tail: wallet.slice(-4) } : null;

  return (
    <form
      className="lw-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (!wallet) return;
        update({ walletConfirmed: true });
        next();
      }}
    >
      <StepHead
        n={3}
        title={`Launch on ${lp.name}`}
        lede={
          <>
            Create your token on {lp.name} as you normally would. The only {BRAND.name}-specific part is one field, <strong>{lp.feeField}</strong>: it decides who receives the creator fees.
          </>
        }
      />

      {wallet ? (
        <WalletCopy wallet={wallet} lp={lp} onCopy={() => setCopied(true)} />
      ) : config.error ? (
        <ErrorNotice
          error={config.error}
          onRetry={config.refresh}
          what={`The ${BRAND.name} wallet address`}
          offlineHint="The address comes straight from the engine. Wait for it to reconnect; never copy it from anywhere else."
        />
      ) : (
        <div className="lw-wallet lw-wallet--pending" role="status">
          <p className="lw-wallet__label">
            Paste this as the <strong>{lp.feeField}</strong> on {lp.name}
          </p>
          <p className="lw-wallet__addr lw-wallet__addr--empty">Connecting to the engine for the wallet address…</p>
        </div>
      )}

      <div className="lw-howto">
        <ol className="lw-howto__steps">
          <li className="lw-howto__step">
            <span className="lw-howto__n num" aria-hidden="true">
              1
            </span>
            <div>
              <h3 className="lw-howto__title">Open {lp.name} and fill in your token</h3>
              <p>Name, ticker, image and socials are all yours to choose.</p>
              {lp.requirements.length > 0 && (
                <ul className="lw-howto__reqs">
                  {lp.requirements.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <ExtLink href={lp.url} className="lw-howto__open">
                Open {lp.name}
              </ExtLink>
            </div>
          </li>
          <li className="lw-howto__step">
            <span className="lw-howto__n num" aria-hidden="true">
              2
            </span>
            <div>
              <h3 className="lw-howto__title">Paste the wallet into {lp.feeField}</h3>
              <p>
                It’s under {lp.feeFieldLocation}. Don’t leave it blank: an empty {lp.feeField} pays the fees to your own wallet, and {BRAND.name} never receives them.
              </p>
              {edges && (
                <p className="lw-howto__check">
                  After pasting, check it starts <span className="num">{edges.head}</span> and ends <span className="num">{edges.tail}</span>.
                </p>
              )}
            </div>
          </li>
          <li className="lw-howto__step">
            <span className="lw-howto__n num" aria-hidden="true">
              3
            </span>
            <div>
              <h3 className="lw-howto__title">Launch, then copy the token’s address</h3>
              <p>
                Confirm in your wallet ({lp.launchFeeEth === null ? 'gas only' : launchFeeText(lp)}). You’ll paste the new token’s contract address in the next step, where {BRAND.name} checks it on-chain.
              </p>
            </div>
          </li>
        </ol>
        <div className="lw-howto__media">
          <LaunchpadLoop key={lp.id} lp={lp} fallback={<FieldPlate lp={lp} wallet={wallet} filled={copied || draft.walletConfirmed} />} />
        </div>
      </div>

      {lp.caveats.length > 0 && (
        <aside className="lw-caveats" aria-label={`About ${lp.name}`}>
          <p className="lw-caveats__title">Good to know about {lp.name}</p>
          <ol>
            {lp.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </aside>
      )}

      <StepNav onBack={back} next="I’ve launched" canNext={wallet !== null} why={config.error ? 'Waiting for the engine to share the wallet address.' : 'Loading the wallet address…'} />
    </form>
  );
}

const LOOP_RECORDED = '27 September 2026';

/**
 * A silent loop of the launchpad's real create form (Advanced opened, the fee field focused), recorded
 * from the live site. It plays only while at least half in view, and the visitor can pause it. Reduced
 * motion, or a loop that fails to load, shows the illustrated plate instead.
 */
function LaunchpadLoop({ lp, fallback }: { lp: LaunchpadInfo; fallback: ReactNode }) {
  const reduced = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [inView, setInView] = useState(false);
  const [paused, setPaused] = useState(false);
  const shown = !reduced && !failed;

  useEffect(() => {
    const v = video.current;
    if (!shown || !v) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), { threshold: 0.5 });
    io.observe(v);
    // <source> errors don't bubble: catch them in the capture phase; only a dead end falls back.
    const onError = () => {
      if (v.error || v.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) setFailed(true);
    };
    v.addEventListener('error', onError, true);
    return () => {
      io.disconnect();
      v.removeEventListener('error', onError, true);
    };
  }, [shown]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    // A blocked play() just leaves the poster up.
    if (inView && !paused) v.play().catch(() => {});
    else v.pause();
  }, [inView, paused]);

  if (!shown) return fallback;
  const host = new URL(lp.url).host.replace(/^www\./, '');
  return (
    <figure className="lw-loop">
      <div className="lw-loop__frame">
        <video
          ref={video}
          className="lw-loop__video"
          muted
          loop
          playsInline
          preload="none"
          width={800}
          height={1000}
          poster={`/media/launch/${lp.id}-poster.jpg`}
          aria-label={`${lp.name}’s create form: ${lp.feeFieldLocation}, then the ${lp.feeField} field`}
        >
          <source src={`/media/launch/${lp.id}.mp4`} type="video/mp4" />
          <source src={`/media/launch/${lp.id}.webm`} type="video/webm" />
        </video>
        <button type="button" className="icon-btn icon-btn--sm lw-loop__pause" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play the recording' : 'Pause the recording'}>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            {paused ? <path d="M6.5 4.5v11l9-5.5z" fill="currentColor" /> : <path d="M7 4.5v11M13 4.5v11" stroke="currentColor" strokeWidth="2" />}
          </svg>
        </button>
      </div>
      <figcaption className="lw-plate__cap">
        Recorded from {host} on {LOOP_RECORDED}: {lp.feeFieldLocation}, then {lp.feeField}. Nothing was typed, connected or submitted.
      </figcaption>
    </figure>
  );
}
