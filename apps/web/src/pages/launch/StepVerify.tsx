import { addressUrl, BRAND, LAUNCHPAD_IDS, LAUNCHPADS, type LaunchpadId, type VerifyCheck, type VerifyResponse } from '@bellwether/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';
import { BellGlyph } from '../../components/Logo';
import { Medallion } from '../../components/Medallion';
import { api, ApiRequestError, isAddress } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { shortAddr } from '../../lib/format';
import { prefersReducedMotion } from '../../lib/prefs';
import { useConfig } from '../../lib/queries';
import { revalidate } from '../../lib/useApi';
import { Checklist, type CheckRow } from './Checklist';
import type { Draft } from './draft';
import { Plan } from './Plan';
import { Registered } from './Registered';
import { StepHead, StepNav } from './StepFrame';

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'done'; result: VerifyResponse } | { state: 'error'; error: unknown };

/** Rows resolve one by one, in the order the engine ran them. */
const STAGGER_MS = 120;
const NOT_CHECKED = /^Not checked/;

export interface VerifiedToken {
  address: string;
  name: string;
  symbol: string;
  image: string | null;
}

/** What each check asks, shown before there's an answer. Labels mirror the engine's; its own replace them. */
function questions(launchpad: LaunchpadId, wallet: string | null): { id: VerifyCheck['id']; label: string; ask: string }[] {
  const lp = LAUNCHPADS[launchpad];
  return [
    { id: 'contract', label: 'Token contract exists on Robinhood Chain', ask: 'Is there a token contract at this address?' },
    { id: 'launchpad', label: `Launched on ${lp.name}`, ask: `Was it created by the ${lp.name} factory?` },
    { id: 'fee-recipient', label: `${lp.feeField} is the ${BRAND.name} protocol wallet`, ask: `Do its creator fees go to ${wallet ?? `the ${BRAND.name} wallet`}?` },
    { id: 'impersonation', label: `Not posing as $${BRAND.ticker}`, ask: `Does its name or symbol imitate $${BRAND.ticker}?` },
    { id: 'not-registered', label: 'Not registered yet', ask: `Is it new to ${BRAND.name}?` },
  ];
}

export function StepVerify({
  draft,
  update,
  back,
  reset,
  onVerified,
}: {
  draft: Draft;
  update: (p: Partial<Draft>) => void;
  back: () => void;
  reset: () => void;
  onVerified: (token: VerifiedToken | null) => void;
}) {
  const config = useConfig().data;
  const wallet = config?.protocolWallet ?? null;
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [fresh, setFresh] = useState(false);
  const immediate = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const address = draft.address.trim();
  const valid = isAddress(address);
  const launchpad = draft.launchpad;
  const notLive = config !== undefined && wallet === null;

  useEffect(() => {
    setSubmitError(null);
    onVerified(null);
    if (!valid || !launchpad || notLive) {
      setCheck({ state: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    setCheck({ state: 'checking' });
    // Typing waits for a pause; a paste or Enter checks at once.
    const delay = immediate.current ? 0 : 350;
    immediate.current = false;
    const t = setTimeout(() => {
      api
        .verify(address, launchpad, ctrl.signal)
        .then((result) => setCheck({ state: 'done', result }))
        .catch((error: unknown) => {
          if (!ctrl.signal.aborted) setCheck({ state: 'error', error });
        });
    }, delay);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [address, valid, launchpad, attempt, notLive, onVerified]);

  const result = check.state === 'done' ? check.result : null;
  const total = result?.checks.length ?? 0;

  // Reveal the engine's answers row by row.
  useEffect(() => {
    if (!result) {
      setShown(0);
      return;
    }
    if (prefersReducedMotion()) {
      setShown(result.checks.length);
      return;
    }
    let i = 1;
    setShown(1);
    const t = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= result.checks.length) clearInterval(t);
    }, STAGGER_MS);
    return () => clearInterval(t);
  }, [result]);

  const settled = result !== null && shown >= total;
  useEffect(() => {
    if (settled && result.ok && result.token) onVerified({ address, ...result.token });
  }, [settled, result, address, onVerified]);

  if (draft.registered) return <Registered address={draft.registered.address} activated={draft.registered.activated} fresh={fresh} reset={reset} />;
  const market = draft.market;
  if (!launchpad || !market) return null;
  const lp = LAUNCHPADS[launchpad];

  const register = async () => {
    if (submitting || !isAddress(address)) return;
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
      setFresh(true);
      update({ registered: { address: res.token.address, activated: res.activated } });
      revalidate('tokens');
      revalidate('stats');
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const asks = questions(launchpad, wallet);
  const source = result ? result.checks : asks.map((q) => ({ id: q.id, label: q.label, ok: false, detail: q.ask }));
  const rows: CheckRow[] = source.map((c, i) => {
    let state: CheckRow['state'] = 'todo';
    let detail = asks.find((q) => q.id === c.id)?.ask ?? c.detail;
    if (result && i < shown) {
      state = c.ok ? 'ok' : NOT_CHECKED.test(c.detail) ? 'skipped' : 'fail';
      detail = c.detail;
    } else if ((check.state === 'checking' && i === 0) || (result && i === shown)) {
      state = 'checking';
    }
    let link: CheckRow['link'] = null;
    if (c.id === 'contract' && valid) link = { href: addressUrl('rhc', address), label: 'Blockscout' };
    else if (c.id === 'launchpad' && result?.token?.deployer) link = { href: addressUrl('rhc', result.token.deployer), label: 'Deployer' };
    else if (c.id === 'fee-recipient' && wallet) link = { href: addressUrl('rhc', wallet), label: `${BRAND.name} wallet` };
    return { id: c.id, label: c.label, state, detail, link };
  });

  // The first real failure; a check that merely couldn't run (metadata unavailable) is the fallback.
  const failed = settled ? (result.checks.find((c) => !c.ok && !NOT_CHECKED.test(c.detail)) ?? result.checks.find((c) => !c.ok) ?? null) : null;
  const passed = result ? result.checks.filter((c) => c.ok).length : 0;
  let status: ReactNode;
  if (notLive) status = `Verification opens once the ${BRAND.name} wallet is live.`;
  else if (!valid) status = address ? 'The checks run once the address is complete.' : 'Waiting for the token’s address.';
  else if (check.state === 'checking') status = 'Checking Robinhood Chain…';
  else if (check.state === 'error') status = 'None of the checks ran.';
  else if (!settled) status = 'Reading the answers…';
  else if (result.ok) status = `All ${total} checks passed.`;
  else status = `${passed} of ${total} checks passed.`;

  const retry = () => {
    immediate.current = true;
    setAttempt((n) => n + 1);
  };
  // The verdict and its buttons go away while the checks rerun; keep keyboard focus on the address.
  const retryFromVerdict = () => {
    retry();
    input.current?.focus();
  };

  return (
    <form
      className="lw-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (settled && result.ok) void register();
        else if (valid) retry();
      }}
    >
      <StepHead
        n={4}
        title="Verify and register"
        lede={`Paste your token’s contract address. ${BRAND.name} checks it on Robinhood Chain before anything is registered, and only a token that passes every check can be.`}
      />

      <div className="field lw-addr">
        <label className="field__label" htmlFor="lw-token-address">
          Token contract address
        </label>
        <input
          ref={input}
          id="lw-token-address"
          className="input input--mono lw-addr__input"
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          value={draft.address}
          disabled={notLive}
          aria-invalid={address.length > 0 && !valid}
          aria-describedby="lw-token-address-hint"
          onPaste={(e) => {
            const text = e.clipboardData.getData('text').trim();
            if (!isAddress(text)) return;
            e.preventDefault();
            immediate.current = true;
            update({ address: text });
          }}
          onChange={(e) => update({ address: e.target.value })}
        />
        <p id="lw-token-address-hint" className="field__hint">
          {address.length > 0 && !valid ? 'That doesn’t look like an address yet: 0x followed by 40 hex characters.' : `The token’s contract on ${lp.name}, not your wallet address. Pasting checks it at once.`}
        </p>
      </div>

      <Checklist rows={rows} status={status} />

      {check.state === 'error' && (
        <div className="lw-verdict lw-verdict--fail" role="alert">
          <p className="lw-verdict__title">The checks couldn’t run.</p>
          <p className="lw-verdict__text">{errorMessage(check.error)}</p>
          {check.error instanceof ApiRequestError && <p className="notice__code">{check.error.code}</p>}
          <div className="row">
            <button type="button" className="btn btn--secondary btn--sm" onClick={retryFromVerdict}>
              <Icon name="refresh" /> Check again
            </button>
          </div>
        </div>
      )}

      {failed && (
        <Fix
          check={failed}
          launchpad={launchpad}
          address={address}
          onRetry={retryFromVerdict}
          onBack={back}
          onSwitch={(id) => {
            immediate.current = true;
            update({ launchpad: id });
            input.current?.focus();
          }}
          onClear={() => {
            update({ address: '' });
            input.current?.focus();
          }}
        />
      )}

      {settled && result.ok && result.token && (
        <div className="lw-verified">
          <div className="lw-verified__token">
            <Medallion image={result.token.image} symbol={result.token.symbol} address={address} size={48} />
            <div>
              <p className="lw-verified__name">
                {result.token.name} <span className="num lw-verified__sym">${result.token.symbol}</span>
              </p>
              <p className="lw-verified__meta">
                On {lp.name} · <span className="num">{shortAddr(address)}</span>
                {result.token.deployer && (
                  <>
                    {' '}
                    · deployed by <span className="num">{shortAddr(result.token.deployer)}</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <Plan draft={draft} symbol={result.token.symbol} />
          {config?.autoApprove === false && <p className="lw-verified__review">This engine reviews new tokens before it starts claiming. Your token page shows “Pending review” until then.</p>}
        </div>
      )}

      {submitError !== null && (
        <div className="lw-verdict lw-verdict--fail" role="alert">
          <p className="lw-verdict__title">Registration didn’t go through.</p>
          <p className="lw-verdict__text">
            {errorMessage(submitError)}{' '}
            {submitError instanceof ApiRequestError && submitError.code === 'already_registered' && <Link to={`/t/${address}`}>Open its token page</Link>}
          </p>
          {submitError instanceof ApiRequestError && <p className="notice__code">{submitError.code}</p>}
        </div>
      )}

      <StepNav
        onBack={back}
        arrow={false}
        next={
          submitting ? (
            'Registering…'
          ) : (
            <>
              <BellGlyph /> Ring the opening bell
            </>
          )
        }
        canNext={settled && result.ok && !notLive}
        busy={submitting}
        why={notLive ? `Opens once the ${BRAND.name} wallet is live.` : 'Every check has to pass first.'}
      />
    </form>
  );
}

/** Human fix for the first failing check: what it means, and the one action that resolves it. */
function Fix({
  check: c,
  launchpad,
  address,
  onRetry,
  onBack,
  onSwitch,
  onClear,
}: {
  check: VerifyCheck;
  launchpad: LaunchpadId;
  address: string;
  onRetry: () => void;
  onBack: () => void;
  onSwitch: (id: LaunchpadId) => void;
  onClear: () => void;
}) {
  const lp = LAUNCHPADS[launchpad];
  let title: string;
  let text: ReactNode;
  let actions: ReactNode;
  const again = (
    <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
      <Icon name="refresh" /> Check again
    </button>
  );
  if (/^Lookup failed/.test(c.detail) || NOT_CHECKED.test(c.detail)) {
    title = 'A check couldn’t run.';
    text = `${c.label}: ${c.detail.replace(/\.$/, '')}. Nothing is known to be wrong with your token; the lookup itself failed. Try again in a moment.`;
    actions = again;
  } else if (c.id === 'contract') {
    title = 'There’s no token at this address.';
    text = `Nothing is deployed there on Robinhood Chain. Make sure you copied the token’s contract address from ${lp.name}, not your wallet or a transaction hash.`;
    actions = (
      <button type="button" className="btn btn--secondary btn--sm" onClick={onClear}>
        Clear the address
      </button>
    );
  } else if (c.id === 'launchpad') {
    const others = LAUNCHPAD_IDS.filter((id) => id !== launchpad);
    title = `This token wasn’t launched on ${lp.name}.`;
    text = 'If you launched it on the other launchpad, check it as that one. Tokens from anywhere else can’t be registered.';
    actions = (
      <>
        {others.map((id) => (
          <button key={id} type="button" className="btn btn--secondary btn--sm" onClick={() => onSwitch(id)}>
            Check as a {LAUNCHPADS[id].name} token
          </button>
        ))}
        {again}
      </>
    );
  } else if (c.id === 'fee-recipient') {
    title = `Its ${lp.feeField} isn’t the ${BRAND.name} wallet.`;
    text = `So its creator fees would never reach ${BRAND.name}. Launch a token on ${lp.name} with the ${BRAND.name} wallet in ${lp.feeField} (${lp.feeFieldLocation}), then verify that one.`;
    actions = (
      <>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onBack}>
          <Icon name="arrowLeft" /> Back to the launch steps
        </button>
        {again}
      </>
    );
  } else if (c.id === 'impersonation') {
    title = `It looks like $${BRAND.ticker}.`;
    text = `Its name or symbol resembles the protocol token. To protect holders, tokens that imitate $${BRAND.ticker} can’t be registered.`;
    actions = null;
  } else {
    title = `This token is already registered with ${BRAND.name}.`;
    text = 'There’s nothing more to do: its page shows its status, fees and burns.';
    actions = (
      <Link to={`/t/${address}`} className="btn btn--secondary btn--sm">
        Open its page <Icon name="arrowRight" />
      </Link>
    );
  }
  return (
    <div className="lw-verdict lw-verdict--fail" role="alert">
      <p className="lw-verdict__title">{title}</p>
      <p className="lw-verdict__text">{text}</p>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
