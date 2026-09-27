import { BRAND, effectiveLeverageCap, STOCK_MARKETS, STRATEGIES, STRATEGY_IDS, type SettingsChallenge, type StrategyId, type TokenDetailResponse } from '@bellwether/shared';
import { useId, useState, type CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { leverage, relTime, shortAddr } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useConfig, useMarkets } from '../../lib/queries';
import { revalidate } from '../../lib/useApi';
import { useWallet, walletErrorMessage } from '../../lib/wallet';

type Token = TokenDetailResponse['token'];

/**
 * Pick settings, get the engine's challenge for exactly those settings, show its message, then sign it.
 * The wallet signs the message on screen, which names this site, the token and every setting.
 */
function SettingsForm({ token, sign }: { token: Token; sign: (message: string) => Promise<`0x${string}`> }) {
  const notify = useToast();
  const markets = useMarkets().data;
  const venueCap = useConfig().data?.venueMaxLeverage ?? null;
  const [strategy, setStrategy] = useState<StrategyId>(token.strategy);
  const [market, setMarket] = useState(token.market);
  const [lev, setLev] = useState(token.maxLeverage);
  const [busy, setBusy] = useState<'idle' | 'challenge' | 'sign' | 'save'>('idle');
  /** Set while the user reviews the message to sign; the fields are locked so they can't drift from it. */
  const [challenge, setChallenge] = useState<SettingsChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(5_000);
  const levId = useId();
  const messageId = useId();

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

  return (
    <form
      className="settings__form"
      onSubmit={(e) => {
        e.preventDefault();
        void (challenge ? signAndSave(challenge) : review());
      }}
    >
      <div className="field">
        <label className="field__label" htmlFor="set-strategy">
          Strategy
        </label>
        <select id="set-strategy" className="select" value={strategy} disabled={locked} onChange={(e) => setStrategy(e.target.value as StrategyId)}>
          {STRATEGY_IDS.map((id) => (
            <option key={id} value={id}>
              {STRATEGIES[id].label} — {STRATEGIES[id].tagline}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="set-market">
          Market
        </label>
        <select id="set-market" className="select" value={market} disabled={locked} onChange={(e) => setMarket(e.target.value)}>
          {options.map((o) => (
            <option key={o.symbol} value={o.symbol}>
              {o.symbol} — {o.name}
            </option>
          ))}
        </select>
      </div>
      {s.trades && (
        <div className="field">
          <label className="field__label" htmlFor={levId}>
            Max leverage <output className="num amber">{tooLow ? '—' : leverage(bounded)}</output>
          </label>
          {tooLow ? (
            <p className="field__hint">This market’s cap ({leverage(cap)}) is below {s.label}’s minimum. Pick another strategy or market.</p>
          ) : (
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
              style={{ '--fill': cap === s.minLeverage ? '100%' : `${((bounded - s.minLeverage) / (cap - s.minLeverage)) * 100}%` } as CSSProperties}
            />
          )}
        </div>
      )}
      {challenge ? (
        <div className="settings__review">
          <p className="field__label" id={messageId}>
            Your wallet will ask you to sign exactly this message
          </p>
          <pre className="settings__message" aria-labelledby={messageId}>
            {challenge.message}
          </pre>
          <p className="field__hint">
            {expired
              ? 'This request expired. Edit the settings and review again for a fresh one.'
              : `Signing is free and sends nothing on-chain. It proves you deployed the token and authorizes only these settings, once. Expires ${relTime(challenge.expiresAt, now)}.`}
          </p>
        </div>
      ) : (
        <p className="field__hint">Direction stays long — shorts aren’t available yet. Next you’ll see the exact message your wallet will sign, before it asks.</p>
      )}
      {error && (
        <p className="callout" role="alert">
          <Icon name="warn" /> {error}
        </p>
      )}
      {challenge ? (
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={expired || busy !== 'idle'}>
            {busy === 'sign' ? 'Check your wallet…' : busy === 'save' ? 'Saving…' : 'Sign & save'}
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
        </div>
      ) : (
        <button type="submit" className="btn btn--primary" disabled={!changed || tooLow || busy !== 'idle'}>
          {busy === 'challenge' ? 'Preparing…' : 'Review & sign'}
        </button>
      )}
    </form>
  );
}

/** Deployer-only settings: connect an injected wallet, review the engine's challenge for the chosen settings, sign it. */
export function CreatorSettings({ token }: { token: Token }) {
  const wallet = useWallet();
  const deployer = token.deployer;
  const isDeployer = Boolean(wallet.account && deployer && wallet.account.toLowerCase() === deployer.toLowerCase());

  let body;
  if (!deployer) {
    body = <p className="dim">{BRAND.name} couldn’t determine who deployed this token, so creator settings are unavailable.</p>;
  } else if (!wallet.available) {
    body = <p className="dim">No browser wallet detected. Open this page in a browser with a wallet extension (for example Rabby or MetaMask) holding the deployer address.</p>;
  } else if (!wallet.account) {
    body = (
      <>
        <p className="dim">
          Only the deployer <code className="num">{shortAddr(deployer)}</code> can change how this token trades.
        </p>
        <button type="button" className="btn btn--secondary" onClick={() => void wallet.connect()} disabled={wallet.connecting}>
          <Icon name="wallet" /> {wallet.connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
        {wallet.error && <p className="field__hint">{wallet.error}</p>}
      </>
    );
  } else if (!isDeployer) {
    body = (
      <p className="callout">
        <Icon name="warn" /> Connected as <code className="num">{shortAddr(wallet.account)}</code>, but only the deployer <code className="num">{shortAddr(deployer)}</code> can change settings. Switch accounts in your
        wallet.
      </p>
    );
  } else {
    body = <SettingsForm token={token} sign={wallet.sign} />;
  }

  return (
    <section className="block card settings" aria-labelledby="settings-title">
      <div className="spread">
        <h2 id="settings-title" className="card__title">
          Creator settings
        </h2>
        {isDeployer && <span className="pill pill--amber">Deployer connected</span>}
      </div>
      {body}
    </section>
  );
}
