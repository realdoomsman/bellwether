import { effectiveLeverageCap, STOCK_MARKETS, STRATEGIES, STRATEGY_IDS, type StrategyId, type TokenDetailResponse } from '@floor/shared';
import { useId, useState, type CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { api, ApiRequestError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { leverage, shortAddr } from '../../lib/format';
import { useConfig, useMarkets } from '../../lib/queries';
import { revalidate } from '../../lib/useApi';
import { useWallet, walletErrorMessage } from '../../lib/wallet';

type Token = TokenDetailResponse['token'];

function SettingsForm({ token, sign }: { token: Token; sign: (message: string) => Promise<`0x${string}`> }) {
  const notify = useToast();
  const markets = useMarkets().data;
  const venueCap = useConfig().data?.venueMaxLeverage ?? null;
  const [strategy, setStrategy] = useState<StrategyId>(token.strategy);
  const [market, setMarket] = useState(token.market);
  const [lev, setLev] = useState(token.maxLeverage);
  const [saving, setSaving] = useState<'idle' | 'challenge' | 'sign' | 'save'>('idle');
  const [error, setError] = useState<string | null>(null);
  const levId = useId();

  const s = STRATEGIES[strategy];
  const m = markets?.markets.find((x) => x.symbol === market);
  const cap = effectiveLeverageCap(strategy, m?.maxLeverage ?? s.maxLeverage, venueCap ?? s.maxLeverage);
  const bounded = s.trades ? Math.min(cap, Math.max(s.minLeverage, lev)) : 0;
  const tooLow = s.trades && cap < s.minLeverage;
  const changed = strategy !== token.strategy || market !== token.market || bounded !== token.maxLeverage;
  const options = markets ? markets.markets.filter((x) => x.available || x.symbol === token.market) : STOCK_MARKETS;

  const save = async () => {
    setError(null);
    try {
      setSaving('challenge');
      const challenge = await api.settingsChallenge(token.address);
      setSaving('sign');
      let signature: `0x${string}`;
      try {
        signature = await sign(challenge.message);
      } catch (err) {
        setError(walletErrorMessage(err));
        return;
      }
      setSaving('save');
      const updated = await api.updateSettings(token.address, { nonce: challenge.nonce, signature, strategy, market, side: 'long', maxLeverage: bounded });
      revalidate(`token:${token.address.toLowerCase()}`);
      revalidate('tokens');
      notify(`Saved. $${updated.symbol} now runs ${STRATEGIES[updated.strategy].label} on ${updated.market}.`, 'success');
    } catch (err) {
      setError(err instanceof ApiRequestError ? errorMessage(err) : walletErrorMessage(err));
    } finally {
      setSaving('idle');
    }
  };

  const busyLabel = { idle: 'Sign & save', challenge: 'Preparing…', sign: 'Check your wallet…', save: 'Saving…' }[saving];

  return (
    <form
      className="settings__form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label className="field__label" htmlFor="set-strategy">
          Strategy
        </label>
        <select id="set-strategy" className="select" value={strategy} onChange={(e) => setStrategy(e.target.value as StrategyId)}>
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
        <select id="set-market" className="select" value={market} onChange={(e) => setMarket(e.target.value)}>
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
              disabled={cap === s.minLeverage}
              onChange={(e) => setLev(Number(e.target.value))}
              style={{ '--fill': cap === s.minLeverage ? '100%' : `${((bounded - s.minLeverage) / (cap - s.minLeverage)) * 100}%` } as CSSProperties}
            />
          )}
        </div>
      )}
      <p className="field__hint">Direction stays long — shorts aren’t available yet. Signing is free: it proves you deployed the token, nothing is sent on-chain.</p>
      {error && (
        <p className="callout" role="alert">
          <Icon name="warn" /> {error}
        </p>
      )}
      <button type="submit" className="btn btn--primary" disabled={!changed || tooLow || saving !== 'idle'}>
        {busyLabel}
      </button>
    </form>
  );
}

/** Deployer-only settings: connect an injected wallet, sign the engine's challenge, submit. */
export function CreatorSettings({ token }: { token: Token }) {
  const wallet = useWallet();
  const deployer = token.deployer;
  const isDeployer = Boolean(wallet.account && deployer && wallet.account.toLowerCase() === deployer.toLowerCase());

  let body;
  if (!deployer) {
    body = <p className="dim">Floor couldn’t determine who deployed this token, so creator settings are unavailable.</p>;
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
