import { BRAND, type VerifyResponse } from '@bellwether/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { Medallion } from '../../components/Medallion';
import { api, ApiRequestError, isAddress } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { shortAddr } from '../../lib/format';
import { useConfig } from '../../lib/queries';
import { revalidate } from '../../lib/useApi';
import type { Draft } from './draft';
import { Plan } from './Plan';
import { WalletNotLive } from './WalletNotLive';

type Check =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; result: VerifyResponse }
  | { state: 'error'; error: unknown };

function Checklist({ result }: { result: VerifyResponse }) {
  return (
    <ul className="checks" aria-label="Verification checks">
      {result.checks.map((c) => (
        <li key={c.id} className={`checks__item ${c.ok ? 'is-ok' : 'is-fail'}`}>
          <span className="checks__icon" aria-hidden="true">
            <Icon name={c.ok ? 'check' : 'close'} size={14} />
          </span>
          <div>
            <p className="checks__label">
              {c.label}
              <span className="sr-only">{c.ok ? ': passed' : ': failed'}</span>
            </p>
            <p className="checks__detail">{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Registered({ address, activated, reset }: { address: string; activated: boolean; reset: () => void }) {
  return (
    <div className={`done ${activated ? 'done--live' : 'done--pending'}`} role="status">
      <p className="done__badge led">{activated ? 'LIVE' : 'QUEUED'}</p>
      <h3>{activated ? 'Registered and active.' : 'Registered — pending review.'}</h3>
      <p className="dim">
        {activated
          ? 'The engine will claim fees on its next cycle. Burns start with the first claim; trading starts once the book reaches the minimum.'
          : 'New tokens on this engine are reviewed before the engine starts claiming. Your token page shows its status the whole time — nothing is hidden while it waits.'}
      </p>
      <div className="row">
        <Link to={`/t/${address}`} className="btn btn--primary">
          Open your token page <Icon name="arrowRight" />
        </Link>
        <button type="button" className="btn btn--ghost" onClick={reset}>
          Launch another
        </button>
      </div>
    </div>
  );
}

export function StepVerify({ draft, update, back, reset }: { draft: Draft; update: (p: Partial<Draft>) => void; back: () => void; reset: () => void }) {
  const notify = useToast();
  const config = useConfig().data;
  const autoApprove = config?.autoApprove;
  // No published wallet: the engine refuses verify/register (wallet_not_configured), so don't ask it.
  const notLive = config?.protocolWallet === null;
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const address = draft.address.trim();
  const valid = isAddress(address);
  const launchpad = draft.launchpad;

  useEffect(() => {
    setSubmitError(null);
    if (!valid || !launchpad || notLive) {
      setCheck({ state: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    setCheck({ state: 'checking' });
    const t = setTimeout(() => {
      api
        .verify(address, launchpad, ctrl.signal)
        .then((result) => setCheck({ state: 'done', result }))
        .catch((error: unknown) => {
          if (!ctrl.signal.aborted) setCheck({ state: 'error', error });
        });
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [address, valid, launchpad, attempt, notLive]);

  if (draft.registered) return <Registered address={draft.registered.address} activated={draft.registered.activated} reset={reset} />;
  const market = draft.market;
  if (!launchpad || !market) return null;

  const register = async () => {
    if (!isAddress(address)) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.register({
        address,
        launchpad,
        market,
        side: 'long',
        strategy: draft.strategy,
        // Burn-only never trades; its effective leverage cap is 0.
        maxLeverage: draft.maxLeverage ?? 0,
      });
      update({ registered: { address: res.token.address, activated: res.activated } });
      revalidate('tokens');
      notify(res.activated ? `$${res.token.symbol} is live on ${BRAND.name}` : `$${res.token.symbol} registered — pending review`, 'success');
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const result = check.state === 'done' ? check.result : null;
  const alreadyRegistered = submitError instanceof ApiRequestError && submitError.code === 'already_registered';

  return (
    <div className="step">
      <p className="step__lede">Paste the contract address of the token you just launched. {BRAND.name} checks it on-chain before anything is registered.</p>

      {notLive && <WalletNotLive />}

      <div className="field">
        <label className="field__label" htmlFor="token-address">
          Token contract address
        </label>
        <input
          id="token-address"
          className="input input--mono"
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          value={draft.address}
          disabled={notLive}
          aria-invalid={address.length > 0 && !valid}
          aria-describedby="token-address-hint"
          onChange={(e) => update({ address: e.target.value })}
        />
        <p id="token-address-hint" className="field__hint">
          {address.length > 0 && !valid ? 'That doesn’t look like an address yet: 0x followed by 40 hex characters.' : 'The token contract, not your wallet address.'}
        </p>
      </div>

      <div className="verify-box" aria-live="polite">
        {check.state === 'idle' && <p className="muted">{notLive ? `Verification opens once the ${BRAND.name} wallet is live.` : 'Checks appear here as soon as the address is complete.'}</p>}
        {check.state === 'checking' && (
          <p className="checking">
            <span className="checking__dots" aria-hidden="true" /> Checking Robinhood Chain…
          </p>
        )}
        {check.state === 'error' && (
          <div className="callout">
            <Icon name="warn" /> <span>{errorMessage(check.error)}</span>{' '}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAttempt((n) => n + 1)}>
              Check again
            </button>
          </div>
        )}
        {result && (
          <>
            {result.token && (
              <div className="token-preview">
                <Medallion image={result.token.image} symbol={result.token.symbol} address={address} size={44} />
                <div>
                  <p className="token-preview__name">
                    {result.token.name} <span className="muted">${result.token.symbol}</span>
                  </p>
                  <p className="muted small num">deployer {shortAddr(result.token.deployer)}</p>
                </div>
              </div>
            )}
            <Checklist result={result} />
            {!result.ok && (
              <div className="spread">
                <p className="dim small">Fix the failing check and re-run. A token whose fee recipient isn’t the {BRAND.name} wallet can’t be registered — relaunch it with the right field.</p>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAttempt((n) => n + 1)}>
                  <Icon name="refresh" /> Check again
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {result?.ok && (
        <>
          <Plan draft={draft} />
          {autoApprove === false && <p className="field__hint">This engine reviews new tokens before activating them. You’ll see “Pending review” on your token page until then.</p>}
        </>
      )}

      {submitError !== null && (
        <div className="callout" role="alert">
          <Icon name="warn" />
          <span>
            {errorMessage(submitError)}{' '}
            {alreadyRegistered && (
              <Link to={`/t/${address}`} className="brass">
                Open its token page
              </Link>
            )}
          </span>
        </div>
      )}

      <div className="step__nav">
        <button type="button" className="btn btn--ghost" onClick={back}>
          <Icon name="arrowLeft" /> Back
        </button>
        <button type="button" className="btn btn--primary" disabled={notLive || !result?.ok || submitting} onClick={register}>
          {submitting ? 'Registering…' : result?.token ? `Register $${result.token.symbol}` : 'Register'}
        </button>
      </div>
    </div>
  );
}
