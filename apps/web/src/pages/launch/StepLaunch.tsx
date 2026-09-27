import { BRAND, LAUNCHPADS } from '@bellwether/shared';
import { CopyButton } from '../../components/CopyButton';
import { ErrorNotice, Loading } from '../../components/DataState';
import { Icon } from '../../components/Icon';
import { ExtLink } from '../../components/Links';
import { useConfig } from '../../lib/queries';
import type { Draft } from './draft';
import { WalletNotLive } from './WalletNotLive';

/** HTML/CSS illustration of the launchpad's advanced section with the fee field filled in. */
function FieldMock({ launchpadName, field, location, wallet }: { launchpadName: string; field: string; location: string; wallet: string }) {
  return (
    <figure className="mock">
      <div className="mock__window" aria-hidden="true">
        <div className="mock__bar">
          <span />
          <span />
          <span />
          <p className="num">{launchpadName.toLowerCase()} · create</p>
        </div>
        <div className="mock__body">
          <div className="mock__field">
            <span className="mock__label">Name</span>
            <span className="mock__input mock__input--ghost">My Token</span>
          </div>
          <div className="mock__field">
            <span className="mock__label">Ticker</span>
            <span className="mock__input mock__input--ghost">MYTKN</span>
          </div>
          <div className="mock__adv">▾ Advanced</div>
          <div className="mock__field mock__field--hot">
            <span className="mock__label">{field}</span>
            <span className="mock__input num">{wallet}</span>
            <span className="mock__pin">Paste the {BRAND.name} wallet here</span>
          </div>
        </div>
      </div>
      <figcaption className="field__hint">
        Illustration: in {location}, the <strong>{field}</strong> field must contain the {BRAND.name} wallet. Everything else is up to you.
      </figcaption>
    </figure>
  );
}

export function StepLaunch({ draft, update, back, next }: { draft: Draft; update: (p: Partial<Draft>) => void; back: () => void; next: () => void }) {
  const config = useConfig();
  const lp = draft.launchpad ? LAUNCHPADS[draft.launchpad] : null;
  if (!lp) return null;
  const wallet = config.data?.protocolWallet;
  // Loaded config with no wallet: the operator hasn't published one. Distinct from loading/offline.
  const notLive = wallet === null;
  const confirmed = draft.walletConfirmed && !notLive;

  return (
    <div className="step">
      <p className="step__lede">
        Create your token on {lp.name} as you normally would. The only {BRAND.name}-specific part is one field: <strong>{lp.feeField}</strong>.
      </p>

      {notLive && <WalletNotLive />}

      <ol className="howto">
        <li>
          <h3>Open {lp.name} and start a new token</h3>
          <p>
            <ExtLink href={lp.url}>{lp.url.replace(/^https:\/\/(www\.)?/, '')}</ExtLink> → {lp.feeFieldLocation.split('→')[0]?.trim()}. Fill in name, ticker, image and socials.
          </p>
          {lp.requirements.length > 0 && (
            <ul className="howto__reqs">
              {lp.requirements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </li>
        <li>
          <h3>
            Paste the {BRAND.name} wallet into “{lp.feeField}”
          </h3>
          <p>You’ll find it under {lp.feeFieldLocation}.</p>
          {notLive ? (
            <p className="muted small">Nothing to paste yet — {BRAND.name} hasn’t published its wallet.</p>
          ) : wallet ? (
            <div className="wallet-box">
              <span className="panel-label">{BRAND.name} protocol wallet</span>
              <code className="wallet-box__addr num">{wallet}</code>
              <CopyButton text={wallet} what={`${BRAND.name} wallet`} label="Copy wallet address" copiedLabel="Copied — now paste it" className="btn btn--primary btn--lg btn--block" />
            </div>
          ) : config.error ? (
            <ErrorNotice
              error={config.error}
              onRetry={config.refresh}
              what={`The ${BRAND.name} wallet address`}
              offlineHint="The address comes straight from the engine. Wait for it to reconnect — never copy it from anywhere else."
            />
          ) : (
            <Loading label={`the ${BRAND.name} wallet`} height={120} />
          )}
        </li>
        <li>
          <h3>Launch</h3>
          <p>{lp.launchFeeEth === null ? 'Confirm the launch in your wallet (gas only).' : `Confirm the launch in your wallet — ${lp.launchFeeEth} ETH launch fee plus gas.`}</p>
        </li>
        <li>
          <h3>Copy your token’s contract address</h3>
          <p>You’ll paste it in the next step so {BRAND.name} can verify it on-chain.</p>
        </li>
      </ol>

      {wallet && <FieldMock launchpadName={lp.name} field={lp.feeField} location={lp.feeFieldLocation} wallet={wallet} />}

      {lp.caveats.length > 0 && (
        <div className="callout">
          <Icon name="warn" />{' '}
          <span>
            {lp.caveats.join(' ')}
          </span>
        </div>
      )}

      {!notLive && (
        <p className="callout">
          <Icon name="warn" /> Check the whole address after pasting. Fees go to whatever address is in {lp.feeField} — if it’s wrong, {BRAND.name} never receives them and can’t recover them.
        </p>
      )}

      <label className="check confirm">
        <input type="checkbox" checked={confirmed} disabled={!wallet} onChange={(e) => update({ walletConfirmed: e.target.checked })} />
        <span>
          I launched my token with the {BRAND.name} wallet in <strong>{lp.feeField}</strong>.
        </span>
      </label>

      <div className="step__nav">
        <button type="button" className="btn btn--ghost" onClick={back}>
          <Icon name="arrowLeft" /> Back
        </button>
        <button type="button" className="btn btn--primary" disabled={!confirmed} onClick={next}>
          Continue <Icon name="arrowRight" />
        </button>
      </div>
    </div>
  );
}
