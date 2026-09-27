import { BRAND, CHAINS, LAUNCHPAD_IDS, LAUNCHPADS } from '@bellwether/shared';
import { Icon } from '../../components/Icon';
import { ExtLink } from '../../components/Links';
import type { Draft } from './draft';

export function StepLaunchpad({ draft, update, next }: { draft: Draft; update: (p: Partial<Draft>) => void; next: () => void }) {
  return (
    <div className="step">
      <p className="step__lede">Where will your token live? {BRAND.name} works with any token from these launchpads, as long as its creator fees point at the {BRAND.name} wallet.</p>

      <fieldset className="choices choices--2">
        <legend className="sr-only">Launchpad</legend>
        {LAUNCHPAD_IDS.map((id) => {
          const lp = LAUNCHPADS[id];
          return (
            <label key={id} className="choice lp">
              <input type="radio" name="launchpad" value={id} checked={draft.launchpad === id} onChange={() => update({ launchpad: id, walletConfirmed: false })} />
              <span className="lp__name">{lp.name}</span>
              <span className="lp__url num">{lp.url.replace(/^https:\/\//, '')}</span>
              <span className="lp__fact">
                Fee field: <strong>{lp.feeField}</strong>
                <span className="muted"> · {lp.feeFieldLocation}</span>
              </span>
              <span className="lp__fact">Launch fee: {lp.launchFeeEth === null ? 'gas only' : <span className="num">{lp.launchFeeEth} ETH + gas</span>}</span>
            </label>
          );
        })}
      </fieldset>

      <aside className="prereq" aria-labelledby="prereq-title">
        <h3 id="prereq-title" className="prereq__title">
          <Icon name="wallet" /> Before you start
        </h3>
        <ul>
          <li>
            A wallet on <strong>{CHAINS.rhc.name}</strong> (chain ID <span className="num">{CHAINS.rhc.chainId}</span>) holding a little ETH for the launch fee and gas.
          </li>
          <li>
            No ETH there yet? Bridge it with the <ExtLink href="https://bridge.arbitrum.io">Arbitrum Bridge</ExtLink> or <ExtLink href="https://across.to">Across</ExtLink>. Bridging usually takes minutes.
          </li>
          <li>
            You keep everything a creator normally has — name, ticker, image, socials. {BRAND.name} never gets your keys; it only receives the creator fees.
          </li>
        </ul>
      </aside>

      <div className="step__nav">
        <span />
        <button type="button" className="btn btn--primary" disabled={!draft.launchpad} onClick={next}>
          Continue <Icon name="arrowRight" />
        </button>
      </div>
    </div>
  );
}
