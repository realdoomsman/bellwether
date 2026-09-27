import {
  effectiveLeverageCap,
  STOCK_MARKETS,
  STRATEGIES,
  STRATEGY_IDS,
  type SettingsChallenge,
  type StrategyId,
  type TokenDetailResponse,
  type TokenSummary,
} from '@bellwether/shared';
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { leverageRange, sessionsText, SplitBar } from '../../components/StrategyFacts';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { etDateTime, leverage, shortAddr } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useConfig, useMarkets } from '../../lib/queries';
import { revalidate } from '../../lib/useApi';
import { useWallet, walletErrorMessage } from '../../lib/wallet';

type Token = TokenDetailResponse['token'];
type Step = 1 | 2 | 3 | 4;

const STEPS = ['Connect the deployer wallet', 'Choose settings', 'Review and sign', 'Saved'] as const;

/** 1 Connect — 2 Choose — 3 Review and sign — 4 Saved; the current step is ink, done steps get ✓. */
function Steps({ at }: { at: Step }) {
  return (
    <ol className="csteps">
      {STEPS.map((label, i) => {
        const n = (i + 1) as Step;
        const state = n < at ? 'done' : n === at ? 'current' : 'todo';
        return (
          <li key={label} className={`csteps__step csteps__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="csteps__n" aria-hidden="true">
              {state === 'done' ? '✓' : n}
            </span>
            {label}
            {state === 'done' && <span className="sr-only"> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** "4:12" until the challenge expires. */
function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Current vs chosen settings, changed lines marked, with the fee split each strategy implies. */
function Preview({ token, strategy, market, lev }: { token: Token; strategy: StrategyId; market: string; lev: number }) {
  const was = STRATEGIES[token.strategy];
  const will = STRATEGIES[strategy];
  const rows: { label: string; now: string; next: string }[] = [
    { label: 'Strategy', now: was.label, next: will.label },
    { label: 'Market', now: `${token.market} perp`, next: `${market} perp` },
    { label: 'Max leverage', now: was.trades ? leverage(token.maxLeverage) : 'None', next: will.trades ? leverage(lev) : 'None' },
    { label: 'Leverage range', now: leverageRange(was), next: leverageRange(will) },
    { label: 'Enters', now: sessionsText(was), next: sessionsText(will) },
  ];
  return (
    <div className="cpreview">
      <table className="cpreview__table">
        <caption className="cpreview__cap">What changes</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Setting</span>
            </th>
            <th scope="col">Now</th>
            <th scope="col">After signing</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const changed = r.now !== r.next;
            return (
              <tr key={r.label} data-changed={changed || undefined}>
                <th scope="row">{r.label}</th>
                <td>{r.now}</td>
                <td>
                  {r.next}
                  {changed && <span className="sr-only"> (changed)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="cpreview__split">
        <div>
          <p className="cpreview__h">Fee split now</p>
          <SplitBar strategy={was} />
        </div>
        <div data-changed={was.trades !== will.trades || undefined}>
          <p className="cpreview__h">After signing</p>
          <SplitBar strategy={will} />
        </div>
      </div>
    </div>
  );
}

/**
 * Pick settings, get the engine's challenge for exactly those settings, show its message, then sign it.
 * The wallet signs the message on screen, which names this site, the token and every setting.
 */
function SettingsForm({ token, sign, account }: { token: Token; sign: (message: string) => Promise<`0x${string}`>; account: string }) {
  const notify = useToast();
  const markets = useMarkets().data;
  const venueCap = useConfig().data?.venueMaxLeverage ?? null;
  const [strategy, setStrategy] = useState<StrategyId>(token.strategy);
  const [market, setMarket] = useState(token.market);
  const [lev, setLev] = useState(token.maxLeverage);
  const [busy, setBusy] = useState<'idle' | 'challenge' | 'sign' | 'save'>('idle');
  /** Set while the user reviews the message to sign; the fields are locked so they can't drift from it. */
  const [challenge, setChallenge] = useState<SettingsChallenge | null>(null);
  const [saved, setSaved] = useState<{ token: TokenSummary; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(challenge ? 1_000 : 30_000);
  const levId = useId();
  const messageId = useId();
  const hintId = useId();

  const s = STRATEGIES[strategy];
  const m = markets?.markets.find((x) => x.symbol === market);
  const cap = effectiveLeverageCap(strategy, m?.maxLeverage ?? s.maxLeverage, venueCap ?? s.maxLeverage);
  const bounded = s.trades ? Math.min(cap, Math.max(s.minLeverage, lev)) : 0;
  const tooLow = s.trades && cap < s.minLeverage;
  const changed = strategy !== token.strategy || market !== token.market || bounded !== token.maxLeverage;
  const options = markets ? markets.markets.filter((x) => x.available || x.symbol === token.market) : STOCK_MARKETS;
  const locked = challenge !== null || busy !== 'idle';
  const expired = challenge !== null && now >= challenge.expiresAt;

  const review = async () => {
    setError(null);
    setBusy('challenge');
    try {
      setChallenge(await api.settingsChallenge(token.address, { strategy, market, side: 'long', maxLeverage: bounded }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy('idle');
    }
  };

  const signAndSave = async (c: SettingsChallenge) => {
    setError(null);
    setBusy('sign');
    let signature: `0x${string}`;
    try {
      signature = await sign(c.message);
    } catch (err) {
      // Rejected or failed in the wallet: the challenge is still good, so the user can sign again.
      setError(walletErrorMessage(err));
      setBusy('idle');
      return;
    }
    setBusy('save');
    try {
      const updated = await api.updateSettings(token.address, { nonce: c.nonce, signature });
      setChallenge(null);
      setSaved({ token: updated, at: Date.now() });
      revalidate(`token:${token.address.toLowerCase()}`);
      revalidate('tokens');
      notify(`Saved. $${updated.symbol} now runs ${STRATEGIES[updated.strategy].label} on ${updated.market}.`, 'success');
    } catch (err) {
      // The nonce may be spent or superseded; the next attempt starts from a fresh challenge.
      setChallenge(null);
      setError(errorMessage(err));
    } finally {
      setBusy('idle');
    }
  };

  if (saved) {
    const u = saved.token;
    const us = STRATEGIES[u.strategy];
    return (
      <>
        <Steps at={4} />
        <article className="receipt csaved" aria-label="Settings saved">
          <p className="receipt__kind">
            <Icon name="check" size={14} /> Settings saved
          </p>
          <p className="receipt__title">
            ${u.symbol} now runs {us.label} on {u.market}
            {us.trades ? `, up to ${leverage(u.maxLeverage)}` : ''}.
          </p>
          <dl className="receipt__rows">
            <div>
              <dt>Signed by</dt>
              <dd className="num">{shortAddr(account)}</dd>
            </div>
            <div>
              <dt>Saved</dt>
              <dd>{etDateTime(saved.at)}</dd>
            </div>
            <div>
              <dt>Takes effect</dt>
              <dd>On the engine’s next run. An open position keeps its exits.</dd>
            </div>
          </dl>
        </article>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSaved(null)}>
          Change again
        </button>
      </>
    );
  }

  return (
    <form
      className="cform"
      onSubmit={(e) => {
        e.preventDefault();
        void (challenge ? signAndSave(challenge) : review());
      }}
    >
      <Steps at={challenge ? 3 : 2} />
      <div className="cform__grid">
        <fieldset className="cform__fields" disabled={locked}>
          <legend className="sr-only">New settings</legend>
          <div className="field">
            <span className="field__label" id={`${levId}-strategy`}>
              Strategy
            </span>
            <div className="cform__choices" role="radiogroup" aria-labelledby={`${levId}-strategy`}>
              {STRATEGY_IDS.map((id) => (
                <label key={id} className="choice cchoice">
                  <input type="radio" name="strategy" value={id} checked={strategy === id} onChange={() => setStrategy(id)} />
                  <span className="cchoice__name">
                    {STRATEGIES[id].label}
                    {id === token.strategy && <span className="cchoice__now">current</span>}
                  </span>
                  <span className="cchoice__tag">{STRATEGIES[id].tagline}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${levId}-market`}>
              Market
            </label>
            <select id={`${levId}-market`} className="select" value={market} onChange={(e) => setMarket(e.target.value)}>
              {options.map((o) => (
                <option key={o.symbol} value={o.symbol}>
                  {o.symbol} — {o.name}
                </option>
              ))}
            </select>
          </div>
          {s.trades && (
            <div className="field">
              <label className="field__label cform__lev" htmlFor={levId}>
                Max leverage <output className="num">{tooLow ? '—' : leverage(bounded)}</output>
              </label>
              {tooLow ? (
                <p className="field__hint field__hint--error">This market’s cap ({leverage(cap)}) is below {s.label}’s minimum. Pick another strategy or market.</p>
              ) : (
                <>
                  <input
                    id={levId}
                    className="range"
                    type="range"
                    min={s.minLeverage}
                    max={cap}
                    step={1}
                    value={bounded}
                    disabled={locked || cap === s.minLeverage}
                    onChange={(e) => setLev(Number(e.target.value))}
                    aria-describedby={hintId}
                    style={{ '--fill': cap === s.minLeverage ? '100%' : `${((bounded - s.minLeverage) / (cap - s.minLeverage)) * 100}%` } as CSSProperties}
                  />
                  <p className="field__hint" id={hintId}>
                    {leverage(s.minLeverage)} to {leverage(cap)} on {market}: the strictest of {s.label}’s range, the market and the venue.
                  </p>
                </>
              )}
            </div>
          )}
          <p className="field__hint">Direction stays long; shorts aren’t available yet.</p>
        </fieldset>
        <Preview token={token} strategy={strategy} market={market} lev={bounded} />
      </div>

      {challenge && (
        <div className="csign">
          <p className="field__label" id={messageId}>
            Your wallet will ask you to sign exactly this message
          </p>
          <div className="receipt csign__slip">
            <pre className="csign__msg" aria-labelledby={messageId}>
              {challenge.message}
            </pre>
          </div>
          <p className={`field__hint${expired ? ' field__hint--error' : ''}`} role={expired ? 'alert' : undefined}>
            {expired ? (
              'This request expired. Edit the settings and review again for a fresh one.'
            ) : (
              <>
                Signing is free and sends nothing on-chain. It proves you deployed the token and authorizes only these settings, once. Expires in{' '}
                <span className="num">{countdown(challenge.expiresAt - now)}</span>.
              </>
            )}
          </p>
        </div>
      )}

      {error && (
        <p className="callout" role="alert">
          <Icon name="warn" /> {error}
        </p>
      )}

      <div className="cform__actions">
        {challenge ? (
          <>
            <button type="submit" className="btn btn--primary" disabled={expired || busy !== 'idle'}>
              <Icon name="wallet" /> {busy === 'sign' ? 'Check your wallet…' : busy === 'save' ? 'Saving…' : 'Sign in wallet and save'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy !== 'idle'}
              onClick={() => {
                setChallenge(null);
                setError(null);
              }}
            >
              Edit settings
            </button>
          </>
        ) : (
          <>
            <button type="submit" className="btn btn--primary" disabled={!changed || tooLow || busy !== 'idle'}>
              {busy === 'challenge' ? 'Preparing…' : 'Review the message to sign'}
            </button>
            <span className="cform__why">{changed ? 'Nothing is signed until you confirm in the next step.' : 'Change a setting to continue.'}</span>
          </>
        )}
      </div>
    </form>
  );
}

/**
 * Deployer-only settings, collapsed at the bottom of the page: connect an injected wallet, pick the
 * new settings against a live preview, review the engine's exact challenge, sign it.
 */
export function CreatorSettings({ token }: { token: Token }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const id = useId();
  const deployer = token.deployer;
  const isDeployer = Boolean(wallet.account && deployer && wallet.account.toLowerCase() === deployer.toLowerCase());

  let body: ReactNode;
  if (!deployer) {
    body = <p className="dim">The engine couldn’t determine who deployed this token, so creator settings are unavailable.</p>;
  } else if (!wallet.available) {
    body = (
      <>
        <Steps at={1} />
        <p className="dim">
          No browser wallet found. Open this page in a browser with a wallet extension (Rabby or MetaMask, for example) holding the deployer address{' '}
          <code className="num">{shortAddr(deployer)}</code>.
        </p>
      </>
    );
  } else if (!wallet.account) {
    body = (
      <>
        <Steps at={1} />
        <p className="dim">
          Only the deployer, <code className="num">{shortAddr(deployer)}</code>, can change how this token trades. Connecting only reads your address.
        </p>
        <div className="row">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void wallet.connect()} disabled={wallet.connecting}>
            <Icon name="wallet" /> {wallet.connecting ? 'Check your wallet…' : 'Connect wallet'}
          </button>
          {wallet.error && <p className="field__hint field__hint--error">{wallet.error}</p>}
        </div>
      </>
    );
  } else if (!isDeployer) {
    body = (
      <>
        <Steps at={1} />
        <p className="callout">
          <Icon name="warn" /> Connected as <code className="num">{shortAddr(wallet.account)}</code>, but only the deployer <code className="num">{shortAddr(deployer)}</code> can change settings. Switch
          accounts in your wallet.
        </p>
      </>
    );
  } else {
    body = <SettingsForm token={token} sign={wallet.sign} account={wallet.account} />;
  }

  return (
    <section className="tkn-creator" aria-labelledby={`${id}-title`}>
      <h2 className="tkn-creator__h" id={`${id}-title`}>
        <button type="button" className="tkn-creator__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          <span className="tkn-creator__title">Creator settings</span>
          <span className="tkn-creator__ask">Are you the creator? Change the strategy, market or leverage.</span>
          {isDeployer && <span className="tkn-creator__who">Deployer connected</span>}
          <Icon name="chevronDown" size={18} className="tkn-creator__chev" />
        </button>
      </h2>
      <div className="fold" id={id} data-open={open || undefined}>
        <div>
          <div className="tkn-creator__body">{body}</div>
        </div>
      </div>
    </section>
  );
}
