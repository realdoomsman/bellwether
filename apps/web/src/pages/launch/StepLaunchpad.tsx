import { BRAND, CHAINS, LAUNCHPAD_IDS, LAUNCHPADS, type LaunchpadId, type LaunchpadInfo } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { ExtLink } from '../../components/Links';
import { eth, shortAddr } from '../../lib/format';
import { CheckMark, type CheckState } from './CheckMark';
import type { Draft } from './draft';
import { launchFeeText, LaunchpadMark } from './LaunchpadMark';
import { StepHead, StepNav } from './StepFrame';
import { RHC_CHAIN_ID, useWalletReadiness } from './useWalletReadiness';

function PadRow({ lp, checked, onPick }: { lp: LaunchpadInfo; checked: boolean; onPick: () => void }) {
  const id = `lw-pad-${lp.id}`;
  return (
    <label className="lw-pad" data-checked={checked || undefined}>
      <input type="radio" name="launchpad" value={lp.id} checked={checked} onChange={onPick} className="lw-radio__input" aria-labelledby={`${id}-name`} aria-describedby={`${id}-facts`} />
      <span className="lw-radio" aria-hidden="true" />
      <LaunchpadMark id={lp.id} />
      <span className="lw-pad__who">
        <span className="lw-pad__name" id={`${id}-name`}>
          {lp.name}
        </span>
        <span className="lw-pad__url num">{new URL(lp.url).host.replace(/^www\./, '')}</span>
      </span>
      <span className="lw-pad__facts" id={`${id}-facts`}>
        <span className="lw-pad__fact">
          <span className="lw-pad__k">Fee field</span>
          <span className="lw-pad__v">
            “{lp.feeField}” <span className="lw-pad__where">in {lp.feeFieldLocation}</span>
          </span>
        </span>
        <span className="lw-pad__fact">
          <span className="lw-pad__k">Launch fee</span>
          <span className="lw-pad__v num">{launchFeeText(lp)}</span>
        </span>
        {lp.caveats.length > 0 && (
          <span className="lw-pad__notes">
            {lp.caveats.map((c, i) => (
              <span key={c} className="lw-pad__note">
                <sup className="num">{i + 1}</sup> {c}
              </span>
            ))}
          </span>
        )}
      </span>
    </label>
  );
}

function ReadyItem({ state, title, children, action }: { state: CheckState; title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="lw-ready__item" data-state={state}>
      <CheckMark state={state} />
      <div className="lw-ready__body">
        <p className="lw-ready__title">{title}</p>
        <p className="lw-ready__detail">{children}</p>
      </div>
      {action && <div className="lw-ready__action">{action}</div>}
    </li>
  );
}

interface Line {
  state: CheckState;
  title: ReactNode;
  detail: ReactNode;
  action?: ReactNode;
}

/** "Before you start": checked against the visitor's browser wallet when there is one, plain guidance otherwise. */
function Readiness({ launchpad }: { launchpad: LaunchpadId | null }) {
  const w = useWalletReadiness();
  const lp = launchpad ? LAUNCHPADS[launchpad] : null;
  const rhc = CHAINS.rhc.name;
  const onChain = w.chainId === RHC_CHAIN_ID;
  const bridge = (
    <>
      Bridge it with the <ExtLink href="https://bridge.arbitrum.io">Arbitrum Bridge</ExtLink> or <ExtLink href="https://across.to">Across</ExtLink>; it usually takes minutes.
    </>
  );

  let chain: Line;
  if (!w.available) {
    chain = { state: 'todo', title: `A wallet on ${rhc}`, detail: `Any browser wallet that can add ${rhc} (chain ID ${RHC_CHAIN_ID}). None is installed in this browser, so it can’t be checked here.` };
  } else if (w.chainId === null) {
    chain = { state: 'checking', title: `A wallet on ${rhc}`, detail: 'Reading the network from your wallet…' };
  } else if (onChain) {
    chain = { state: 'ok', title: `Your wallet is on ${rhc}`, detail: `Chain ID ${RHC_CHAIN_ID}, read from your browser wallet just now.` };
  } else {
    chain = { state: 'warn', title: `Switch your wallet to ${rhc}`, detail: `It’s on chain ID ${w.chainId} right now. Both launchpads run on ${rhc} only (chain ID ${RHC_CHAIN_ID}).` };
  }

  const feeLine = lp ? `${lp.name}: ${lp.launchFeeEth === null ? 'gas only' : launchFeeText(lp)}.` : 'A launch fee (if any) plus gas.';
  let funds: Line;
  if (w.account && onChain && w.balanceEth !== null) {
    const who = <span className="num">{shortAddr(w.account)}</span>;
    funds =
      w.balanceEth > (lp?.launchFeeEth ?? 0)
        ? { state: 'ok', title: <><span className="num">{eth(w.balanceEth)}</span> on {rhc}</>, detail: <>In {who}. {feeLine}</> }
        : { state: 'warn', title: `Not enough ETH on ${rhc} yet`, detail: <><span className="num">{eth(w.balanceEth)}</span> in {who}. {bridge}</> };
  } else if (w.account && onChain) {
    funds = { state: 'checking', title: 'ETH for the launch fee and gas', detail: 'Reading your balance…' };
  } else {
    funds = {
      state: 'todo',
      title: 'ETH for the launch fee and gas',
      detail: (
        <>
          {feeLine} No ETH on {rhc} yet? {bridge}
          {w.error && <span className="lw-ready__err"> {w.error}</span>}
        </>
      ),
      action:
        w.available && !w.account ? (
          <button type="button" className="btn btn--secondary btn--sm" onClick={w.connect} disabled={w.connecting}>
            {w.connecting ? 'Waiting for wallet…' : 'Check my wallet'}
          </button>
        ) : undefined,
    };
  }

  return (
    <section className="lw-ready" aria-labelledby="lw-ready-title">
      <h3 id="lw-ready-title" className="lw-sub">
        Before you start
      </h3>
      <ul className="lw-ready__list" aria-live="polite">
        <ReadyItem state={chain.state} title={chain.title}>
          {chain.detail}
        </ReadyItem>
        <ReadyItem state={funds.state} title={funds.title} action={funds.action}>
          {funds.detail}
        </ReadyItem>
      </ul>
      <p className="lw-ready__foot">
        You keep everything a creator normally has: the name, ticker, image and socials are yours, and {BRAND.name} never asks for your keys. It only receives the creator fees.
      </p>
    </section>
  );
}

export function StepLaunchpad({ draft, update, next }: { draft: Draft; update: (p: Partial<Draft>) => void; next: () => void }) {
  return (
    <form
      className="lw-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.launchpad) next();
      }}
    >
      <StepHead
        n={1}
        title="Choose a launchpad"
        lede={`${BRAND.name} works with tokens from these two launchpads. You launch there exactly as you normally would; the only difference is one field that names who receives the creator fees.`}
      />
      <fieldset className="lw-pads">
        <legend className="sr-only">Launchpad</legend>
        {LAUNCHPAD_IDS.map((id) => (
          <PadRow key={id} lp={LAUNCHPADS[id]} checked={draft.launchpad === id} onPick={() => update({ launchpad: id, walletConfirmed: false })} />
        ))}
      </fieldset>
      <Readiness launchpad={draft.launchpad} />
      <StepNav canNext={draft.launchpad !== null} why="Choose a launchpad to continue." />
    </form>
  );
}
